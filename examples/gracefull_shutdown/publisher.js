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
  name: "publisher",
  version: 1,

  mixins: [
    queueMixin,
  ],

  settings: {
    amqp: {
      connection: "amqp://localhost", // You can also override setting from service setting
    },
  },

  async started() {
    await broker.waitForServices({ name: "consumer", version: 1 });

    let name = "repeat_name";
    setInterval(async () => {
      const response = await broker.call("v1.consumer.hello.async", {
        // `params` is the real param will be passed to original action
        params: {
          name,
        },
        // `options` is the real options will be passed to original action
        options: {
          timeout: 12000,
        },
      });
      this.logger.info(`[PUBLISHER] PID: ${process.pid} Called job with name=${name} response=${JSON.stringify(response)}`);
    }, 500);
  }
});

broker.start().then(() => {
  broker.repl();
});
