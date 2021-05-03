const Amqplib = require("amqplib");
const DefaultDeep = require("defaults-deep");
const Deep = require("deep-get-set");
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
        "x-delayed-type": "direct",
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
  dedupHash: null,
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

const gracefulShutdown = async function () {
  isShuttingDown = true;

  Object.keys(this.$amqpQueues).forEach(async (queueName) => {
    const { channel, consumerTag } = this.$amqpQueues[queueName] || {};

    channel && consumerTag && await channel.cancel(consumerTag);
  });
};

const closeConnection = async function () {
  Object.keys(this.$amqpQueues).forEach((queueName) => {
    const { channel } = this.$amqpQueues[queueName];
    channel && channel.close();
  });

  this.$amqpConnection && await this.$amqpConnection.close();
};

const initAMQPQueues = function (schema) {
  Object.keys(schema.actions || {}).forEach((originActionName) => {
    if (schema.actions[originActionName] && schema.actions[originActionName].queue) {
      const queueName = `amqp.${schema.version ? `v${schema.version}.` : ""}${schema.name}.${originActionName}`;

      const queueOption = DefaultDeep({}, schema.actions[originActionName].queue, DEFAULT_QUEUE_OPTIONS);

      this.$amqpQueues[queueName] = {
        options: queueOption,
        async consumeHandler(channel, msg) {
          messagesBeingProcessed++;
          const {
            retry: retryOptions,
          } = queueOption;

          let messageData;
          try {
            messageData = JSON.parse(msg.content.toString()) || {};
          } catch (error) {
            this.logger.error("[AMQP] parse message content failed", error);
            return await channel.reject(msg, false);
          }

          const actionName = `${this.version ? `v${this.version}.` : ""}${this.name}.${originActionName}`;
          const actionParams = messageData.params || {};
          const actionOptions = DefaultDeep({}, messageData.options);

          try {
            await this.broker.call(actionName, actionParams, actionOptions);
            return await channel.ack(msg);
          } catch (error) {
            try {
              if (retryOptions === true) {
                await channel.nack(msg, true, true);
              } else if (retryOptions && retryOptions.max_retry > 0) {
                await channel.nack(msg, true, false);
                const retry_count = (Deep(msg, "properties.headers.x-retries") || 0) + 1;
                let retry_delay = 0;
                if (typeof retryOptions.delay === "function") {
                  retry_delay = retryOptions.delay(retry_count);
                } else if (typeof retryOptions.delay === "number") {
                  retry_delay = retryOptions.delay;
                }

                if (retry_count <= retryOptions.max_retry) {
                  error.message += ` (Retring retry_count=${retry_count} in ${retry_delay} ms)`;
                  const headers = Deep(msg, "properties.headers") || {};
                  headers["x-retries"] = retry_count;
                  headers["x-delay"] = retry_delay;
                  await channel.publish(`${queueName}.retry`, queueName, msg.content, {
                    headers,
                  });
                } else {
                  error.message += ` (Reached max_retry=${retryOptions.max_retry}, throwing away)`;
                }
              } else {
                await channel.nack(msg, true, false);
              }
              this.logger.error("[AMQP] consumer throw error", error);
            } catch (retryError) {
              this.logger.error("[AMQP] consumer retry message failed", retryError);
            }
          } finally {
            messagesBeingProcessed--;
            if (isShuttingDown && messagesBeingProcessed == 0) {
              await closeConnection.call(this);
            }
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

  if (Deep(schema, "settings.amqp.asyncActions")) {
    Object.keys(schema.actions).forEach((actionName) => {
      if (schema.actions[actionName] && schema.actions[actionName].queue) {
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

        const queueName = `amqp.${schema.version ? `v${schema.version}.` : ""}${schema.name}.${actionName}`;
        schema.actions[`${actionName}.async`] = {
          timeout: 10000,
          retryPolicy: {
            enabled: true,
            retries: 2,
          },
          params: asyncParams,
          async handler(ctx) {
            const dedupeHash = Deep(this.$amqpQueues, [queueName, "options", "dedupHash"]);
            const headers = ctx.headers || {};
            if (typeof dedupeHash === "number" || typeof dedupeHash === "string") {
              headers["x-deduplication-header"] = String(dedupeHash);
            } else if (typeof dedupeHash === "function") {
              headers["x-deduplication-header"] = dedupeHash({
                ...ctx,
                params: ctx.params.params,
                options: ctx.params.options,
              });
            }

            return this.sendAMQPMessage(queueName, {
              params: ctx.params.params,
              options: ctx.params.options,
            }, {
              headers,
            });
          },
        };
      }
    });
  }

  return schema;
};

let isShuttingDown = false;
let messagesBeingProcessed = 0;

module.exports = (options) => ({
  name: "moleculer-rabbitmq",

  methods: {
    async connectAMQP() {
      try {
        this.$amqpConnection = await Amqplib.connect(this.settings.amqp.connection);
      } catch (ex) {
        this.logger.error("[AMQP] Unable to connect to rabbitmq", ex);
        throw new MoleculerError("[AMQP] Unable to connect to rabbitmq");
      }

      this.$amqpConnection.on("error", function (err) {
        if (err.message !== "Connection closing") {
          this.logger.error("[AMQP] connection error", err);
          throw new MoleculerError("[AMQP] connection unhandled exception");
        }
      });
      this.$amqpConnection.on("close", function () {
        this.logger.error("[AMQP] connection is closed");
        throw new MoleculerError("[AMQP] connection closed");
      });

      try {
        await this.initAMQPConsumers();
      } catch (ex) {
        this.logger.error(ex);
        throw new MoleculerError("[AMQP] Failed to init consumers");
      }
    },

    async assertAMQPQueue(queueName) {
      if (!Deep(this.$amqpQueues, [queueName, "channel"])) {
        const {
          options: {
            amqp: amqpOptions = {},
          } = {},
        } = this.$amqpQueues[queueName] || {};

        try {
          const channel = await this.$amqpConnection.createChannel();
          channel.on("close", () => {
            Deep(this.$amqpQueues, [queueName, "channel"], null);
            this.logger.error("[AMQP] channel closed");
            throw new MoleculerError("[AMQP] channel closed");
          });
          channel.on("error", (err) => {
            this.logger.error("[AMQP] channel error", err);
            throw new MoleculerError("[AMQP] channel unhandled exception");
          });

          await channel.assertQueue(queueName, amqpOptions.queueAssert);

          if (amqpOptions.prefetch != null) {
            channel.prefetch(amqpOptions.prefetch);
          }

          if (amqpOptions.retryExchangeAssert) {
            await channel.assertExchange(`${queueName}.retry`, "x-delayed-message", amqpOptions.retryExchangeAssert);
            await channel.bindQueue(queueName, `${queueName}.retry`, queueName);
          }

          Deep(this.$amqpQueues, [queueName, "channel"], channel);
        } catch (err) {
          this.logger.error("[AMQP] assert amqp queue error", err);
          throw new MoleculerError("Unable to start queue");
        }
      }

      return Deep(this.$amqpQueues, [queueName, "channel"]);
    },

    async sendAMQPMessage(name, message, options) {
      const messageOption = DefaultDeep({}, options, DEFAULT_MESSAGE_OPTIONS);
      let queue = await this.assertAMQPQueue(name);
      return queue.sendToQueue(name, Buffer.from(JSON.stringify(message)), messageOption);
    },

    async initAMQPConsumers() {
      Object.entries(this.$amqpQueues).forEach(async ([queueName, queue]) => {
        const {
          consumeHandler,
          options: {
            consume: consumeOptions,
          } = {},
        } = queue;

        const amqpChannel = await this.assertAMQPQueue(queueName);
        const {
          consumerTag,
        } = await amqpChannel.consume(queueName, consumeHandler.bind(this, amqpChannel), consumeOptions);
        this.$amqpQueues[queueName].consumerTag = consumerTag;
      });
    },
  },

  merged(schema) {
    this.$amqpConnection = null;
    this.$amqpQueues = {};

    if (!schema.settings) {
      schema.settings = {};
    }

    schema.settings.amqp = DefaultDeep({}, schema.settings.amqp, options, {
      connection: "amqp://localhost",
      asyncActions: true,
    });

    initAMQPQueues.bind(this)(schema);

    initAMQPActions.bind(this)(schema);
  },

  async started() {
    if (!Deep(this.settings, "amqp.connection")) {
      this.logger.warn(`${this.version ? `v${this.version}.` : ""}${this.name} is disabled because of empty "amqp.connection" setting`);
      return;
    }

    if (!["string", "object"].includes(typeof this.settings.amqp.connection)) {
      throw new ServiceSchemaError("Setting amqp.connection must be connection string or object");
    }

    try {
      this.$amqpConnection = await Amqplib.connect(this.settings.amqp.connection);
    } catch (ex) {
      this.logger.error("[AMQP] Unable to connect to rabbitmq", ex);
      throw new MoleculerError("[AMQP] Unable to connect to rabbitmq");
    }

    process.on("SIGTERM", gracefulShutdown.bind(this));
    process.on("SIGINT", gracefulShutdown.bind(this));
    process.on("SIGUSR1", gracefulShutdown.bind(this));
    process.on("SIGUSR2", gracefulShutdown.bind(this));
  }
});
