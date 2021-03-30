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
  channel: {
    assert: {
      durable: true,
      // arguments: {
      //   "x-message-deduplication": true,
      // },
    },
    prefetch: 0,
  },
  consume: {
    noAck: false,
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
      const queueName = `amqp.${schema.name}.${originActionName}`;

      const queueOption = Lodash.defaultsDeep({}, schema.actions[originActionName].queue, DEFAULT_QUEUE_OPTIONS);

      this.$amqpOptions[queueName] = {
        options: queueOption,
        async consumer(channel, msg) {
          let messageData;
          try {
            messageData = JSON.parse(msg.content.toString()) || {};
          } catch (error) {
            return channel.reject(msg, false);
          }

          const actionName = `${this.name}.${originActionName}`;
          const actionParams = messageData.params || {};
          const actionOptions = Lodash.defaultsDeep({}, messageData.options);

          try {
            await this.broker.call(actionName, actionParams, actionOptions);
            return channel.ack(msg);
          } catch (error) {
            this.logger.error(error);
            // if (msg.fields && msg.fields.redelivered) {
            //   return channel.reject(msg, false);
            // }

            return channel.nack(msg);
          }
        },
      };
    }
  });

  return schema;
};

const initAMQPActions = function (schema) {
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
        return this.sendAMQPMessage(ctx.action, {
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
    Object.keys(schema.actions || {}).forEach((actionName) => {
      if (schema.actions[actionName] && schema.actions[actionName].queue) {
        const queueName = `amqp.${schema.name}.${actionName}`;

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
    async assertAMQPQueue(name) {
      if (!this.$amqpQueues[name]) {
        const {
          channel: channelOptions = {},
        } = this.$amqpOptions[name] || {};

        try {
          const channel = await this.$amqpConnection.createChannel();
          channel.on("close", () => {
            delete this.$amqpQueues[name];
          });
          channel.on("error", (err) => {
            this.logger.error(err);
          });

          await channel.assertQueue(name, channelOptions.assert);

          if (channelOptions.prefetch != null) {
            channel.prefetch(channelOptions.prefetch);
          }

          this.$amqpQueues[name] = channel;
        } catch (err) {
          this.logger.error(err);
          throw new MoleculerError("Unable to start queue");
        }
      }

      return this.$amqpQueues[name];
    },

    async sendAMQPMessage(name, message, options) {
      const messageOption = Lodash.defaultsDeep({}, options, DEFAULT_MESSAGE_OPTIONS);
      let queue = await this.assertAMQPQueue(name);
      return queue.sendToQueue(name, Buffer.from(JSON.stringify(message)), messageOption);
    },

    async initAMQPConsumers() {
      Object.entries(this.$amqpOptions).forEach(async ([queueName, queueOption]) => {
        const {
          consumer,
          consume: consumeOptions,
        } = queueOption;

        const amqpChannel = await this.assertAMQPQueue(queueName);
        amqpChannel.consume(queueName, consumer.bind(this, amqpChannel), consumeOptions);
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
      this.logger.warn(`${this.name} is disabled because of empty "amqp.connection" setting`);
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
