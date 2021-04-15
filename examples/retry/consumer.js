const { ServiceBroker } = require("moleculer");
const QueueMixin = require("../../index");

let broker = new ServiceBroker({
  logger: console,
  transporter: "TCP",
});

const queueMixin = QueueMixin({
  connection: "amqp://localhost",
  asyncActions: true, // Enable auto generate .async version for actions
});

broker.createService({
  name: "consumer",
  version: 1,

  mixins: [
    queueMixin,
  ],

  settings: {
    amqp: {
      connection: "amqp://localhost", // You can also override setting from service setting
    },
  },

  actions: {
    hello: {
      queue: { // Enable queue for this action
        // Options for AMQP queue
        amqp: {
          queueAssert: {
            exclusive: false, // (boolean) if true, scopes the queue to the connection (defaults to false)
            durable: true, // (boolean) if true, the queue will survive broker restarts, modulo the effects of exclusive and autoDelete; this defaults to true if not supplied, unlike the others
            autoDelete: false, // (boolean) if true, the queue will be deleted when the number of consumers drops to zero (defaults to false)
            arguments: { // additional arguments, usually parameters for some kind of broker-specific extension e.g., high availability, TTL
            },
          },
          prefetch: 0,
        },
        retryExchangeAssert: {
          durable: true, // (boolean) if true, the exchange will survive broker restarts. Defaults to true.
          autoDelete: false, // (boolean) if true, the exchange will be destroyed once the number of bindings for which it is the source drop to zero. Defaults to false.
          alternateExchange: null, // (string) an exchange to send messages to if this exchange can’t route them to any queues.
          arguments: { // additional arguments, usually parameters for some kind of broker-specific extension e.g., high availability, TTL
          },
        },
        retry: true, // Using rabbitmq default requeue logic (retry forever)
        // retry: {
        //   max_retry: 3,
        //   delay: (retry_count) => {
        //     return retry_count * 1000;
        //   },
        // },
      },
      params: {
        name: "string|convert:true|empty:false",
      },
      async handler(ctx) {
        this.logger.info(`[CONSUMER] PID: ${process.pid} Received job with name=${ctx.params.name}`);
        return new Promise((resolve, reject) => {
          setTimeout(() => {
            this.logger.info(`[CONSUMER] PID: ${process.pid} Processed job with name=${ctx.params.name}`);
            return reject(new Error("TEST"));
          }, 1000);
        });
      },
    },
  },
});

broker.start().then(() => {
  broker.repl();
});
