const { ServiceBroker } = require("moleculer");
const QueueMixin = require("../../index");

let broker = new ServiceBroker({
  logger: console,
  transporter: "TCP",
  tracking: { // Enable moleculer graceful shutdown
    enabled: true,
    shutdownTimeout: 30 * 1000
  }
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
            durable: true,
          },
          consume: {
            noAck: false,
          },
          prefetch: 0,
        },
        dedupHash: (ctx) => {
          return ctx.params.name;
        },
      },
      params: {
        name: "string|convert:true|empty:false",
      },
      async handler(ctx) {
        this.logger.info(`[CONSUMER] PID: ${process.pid} Received job with name=${ctx.params.name}`);
        return new Promise((resolve) => {
          setTimeout(() => {
            this.logger.info(`[CONSUMER] PID: ${process.pid} Processed job with name=${ctx.params.name}`);
            return resolve(`hello ${ctx.params.name}`);
          }, 3000); // Simulate slow task
        });
      },
    },
  },
});

broker.start().then(() => {
  broker.repl();
});
