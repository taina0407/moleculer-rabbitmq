const Amqplib = require("amqplib");
const Lodash = require("lodash");
const {
  MoleculerError,
  ServiceSchemaError,
} = require("moleculer").Errors;

const DEFAULT_MESSAGE_OPTIONS = {
  persistent: true,
};

const DEFAULT_QUEUE_OPTIONS = {
  amqp: {
    queueAssert: {
      exclusive: false, // (boolean) if true, scopes the queue to the connection (defaults to false)
      durable: true, // (boolean) if true, the queue will survive broker restarts, modulo the effects of exclusive and autoDelete; this defaults to true if not supplied, unlike the others
      autoDelete: false, // (boolean) if true, the queue will be deleted when the number of consumers drops to zero (defaults to false)
      arguments: { // additional arguments, usually parameters for some kind of broker-specific extension e.g., high availability, TTL
        "x-message-deduplication": true,
      },
    },
    retryExchangeAssert: {
      durable: true, // (boolean) if true, the exchange will survive broker restarts. Defaults to true.
      autoDelete: false, // (boolean) if true, the exchange will be destroyed once the number of bindings for which it is the source drop to zero. Defaults to false.
      alternateExchange: null, // (string) an exchange to send messages to if this exchange can’t route them to any queues.
      arguments: { // additional arguments, usually parameters for some kind of broker-specific extension e.g., high availability, TTL
        "arguments.x-delayed-type": "direct",
        "x-message-deduplication": true,
      },
    },
    consume: {
      noAck: false,
    },
    prefetch: 0,
  },
  retry: {
    max_retry: 0,
    delay: 0,
  },
};

const ACTION_OPTIONS_VALIDATOR = {
  type: "object",
  props: {
    timeout: "number|int|convert:true|optional:true",
    retries: "number|int|convert:true|optional:true",
    fallbackResponse: "any|optional:true",
    nodeID: "string|optional:true",
    meta: "object|strict:false|optional:true",
    parentCtx: "object|strict:false|optional:true",
    requestID: "string|optional:true",
  },
  optional: true,
};

const initAMQPQueues = function (schema) {
  Object.keys(schema.actions || {}).forEach((originActionName) => {
    if (schema.actions[originActionName] && schema.actions[originActionName].queue) {
      const queueName = `amqp.${schema.version ? `v${schema.version}.` : ""}${schema.name}.${originActionName}`;

      const queueOption = Lodash.defaultsDeep({}, schema.actions[originActionName].queue, DEFAULT_QUEUE_OPTIONS);

      this.$amqpOptions[queueName] = {
        options: queueOption,
        async consumeHandler(channel, msg) {
          const {
            retry: retryOptions,
          } = queueOption;

          let messageData;
          try {
            messageData = JSON.parse(msg.content.toString()) || {};
          } catch (error) {
            return channel.reject(msg, false);
          }

          const actionName = `${this.version ? `v${this.version}.` : ""}${this.name}.${originActionName}`;
          const actionParams = messageData.params || {};
          const actionOptions = Lodash.defaultsDeep({}, messageData.options);

          try {
            await this.broker.call(actionName, actionParams, actionOptions);
            return channel.ack(msg);
          } catch (error) {
            try {
              if (retryOptions === true) {
                await channel.nack(msg, true, true);
              } else if (retryOptions && retryOptions.max_retry > 0) {
                await channel.nack(msg, true, false);
                const retry_count = (Lodash.get(msg, "properties.headers.x-retries") || 0) + 1;
                let retry_delay = 0;
                if (typeof retryOptions.delay === "function") {
                  retry_delay = retryOptions.delay(retry_count);
                } else if (typeof retryOptions.delay === "number") {
                  retry_delay = retryOptions.delay;
                }

                if (retry_count <= retryOptions.max_retry) {
                  error.message += ` (Retring retry_count=${retry_count} in ${retry_delay} ms)`;
                  await channel.publish(`${queueName}.retry`, queueName, msg.content, {
                    headers: {
                      "x-retries": retry_count,
                      "x-delay": retry_delay,
                    },
                  });
                } else {
                  error.message += ` (Reached max_retry=${retryOptions.max_retry}, throwing away)`;
                }
              } else {
                await channel.nack(msg, true, false);
              }
            } catch (retryError) {
              this.logger.error(retryError);
            }

            this.logger.error(error);
          }
        },
      };
    }
  });

  return schema;
};

const initAMQPActions = function (schema) {
  if (!schema.actions) {
    schema.actions = {};
  }

  if (schema.settings.amqp.localPublisher) {
    schema.actions.callAsync = {
      visibility: "private",
      params: {
        action: "string|empty:false|optional:false",
        params: "object|strict:false|optional",
        options: ACTION_OPTIONS_VALIDATOR,
        headers: "object|strict:false|optional",
      },
      timeout: 10000,
      retryPolicy: {
        enabled: true,
        retries: 2,
      },
      async handler(ctx) {
        const queueName = `amqp.${ctx.params.action}`;

        return this.sendAMQPMessage(queueName, {
          params: ctx.params.params,
          options: ctx.params.options,
        }, {
          headers: {
            ...ctx.headers,
            // "x-deduplication-header": ObjectHash(ctx.params),
          },
        });
      },
    };
  }

  if (schema.settings.amqp.asyncActions) {
    Object.keys(schema.actions).forEach((actionName) => {
      if (schema.actions[actionName] && schema.actions[actionName].queue) {
        const queueName = `amqp.${schema.version ? `v${schema.version}.` : ""}${schema.name}.${actionName}`;

        const asyncParams = {
          options: ACTION_OPTIONS_VALIDATOR,
          headers: "object|strict:false|optional",
        };
        if (Object.keys(schema.actions[actionName].params).length) {
          asyncParams.params = {
            type: "object",
            props: schema.actions[actionName].params,
          };
        }

        schema.actions[`${actionName}.async`] = {
          timeout: 10000,
          retryPolicy: {
            enabled: true,
            retries: 2,
          },
          params: asyncParams,
          async handler(ctx) {
            return this.sendAMQPMessage(queueName, {
              params: ctx.params.params,
              options: ctx.params.options,
            }, {
              headers: {
                ...ctx.headers,
                // "x-deduplication-header": ObjectHash(ctx.params),
              }
            });
          },
        };
      }
    });
  }

  return schema;
};

module.exports = (options) => ({
  name: "moleculer-rabbitmq",

  methods: {
    async assertAMQPQueue(queueName) {
      if (!this.$amqpQueues[queueName]) {
        const {
          options: {
            amqp: amqpOptions = {},
          } = {},
        } = this.$amqpOptions[queueName] || {};

        try {
          const channel = await this.$amqpConnection.createChannel();
          channel.on("close", () => {
            delete this.$amqpQueues[queueName];
          });
          channel.on("error", (err) => {
            this.logger.error(err);
          });

          await channel.assertQueue(queueName, amqpOptions.queueAssert);

          if (amqpOptions.prefetch != null) {
            channel.prefetch(amqpOptions.prefetch);
          }

          if (amqpOptions.retryExchangeAssert) {
            await channel.assertExchange(`${queueName}.retry`, "x-delayed-message", amqpOptions.retryExchangeAssert);
            await channel.bindQueue(queueName, `${queueName}.retry`, queueName);
          }

          this.$amqpQueues[queueName] = channel;
        } catch (err) {
          this.logger.error(err);
          throw new MoleculerError("Unable to start queue");
        }
      }

      return this.$amqpQueues[queueName];
    },

    async sendAMQPMessage(name, message, options) {
      const messageOption = Lodash.defaultsDeep({}, options, DEFAULT_MESSAGE_OPTIONS);
      let queue = await this.assertAMQPQueue(name);
      return queue.sendToQueue(name, Buffer.from(JSON.stringify(message)), messageOption);
    },

    async initAMQPConsumers() {
      Object.entries(this.$amqpOptions).forEach(async ([queueName, queueOption]) => {
        const {
          consumeHandler,
          consume: consumeOptions,
        } = queueOption;

        const amqpChannel = await this.assertAMQPQueue(queueName);
        amqpChannel.consume(queueName, consumeHandler.bind(this, amqpChannel), consumeOptions);
      });
    },
  },

  merged(schema) {
    this.$amqpConnection = null;
    this.$amqpQueues = {};
    this.$amqpOptions = {};

    if (!schema.settings) {
      schema.settings = {};
    }

    schema.settings.amqp = Lodash.defaultsDeep({}, schema.settings.amqp, options, {
      connection: "amqp://localhost",
      asyncActions: true,
      localPublisher: false,
    });

    initAMQPQueues.bind(this)(schema);

    initAMQPActions.bind(this)(schema);
  },

  async started() {
    if (!this.settings.amqp || !this.settings.amqp.connection) {
      this.logger.warn(`${this.version ? `v${this.version}.` : ""}${this.name} is disabled because of empty "amqp.connection" setting`);
    }

    if (!["string", "object"].includes(typeof this.settings.amqp.connection)) {
      throw new ServiceSchemaError("Setting amqp.connection must be connection string or object");
    }

    try {
      this.$amqpConnection = await Amqplib.connect(this.settings.amqp.connection);
    } catch (ex) {
      this.logger.error(ex);
      throw new MoleculerError("Unable to connect to AMQP");
    }

    try {
      await this.initAMQPConsumers();
    } catch (ex) {
      this.logger.error(ex);
      throw new MoleculerError("Failed to init AMQP consumers");
    }
  }
});
