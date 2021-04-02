# moleculer-rabbitmq [![NPM version](https://img.shields.io/npm/v/moleculer-rabbitmq.svg)](https://www.npmjs.com/package/moleculer-rabbitmq)

Task queue mixin for RabbitMQ [AMQP](https://www.amqp.org/).

# Install

```bash
$ npm install moleculer-rabbitmq --save
```

# Usage

## Enable async queue for exist action

```js
const QueueMixin = require("moleculer-rabbitmq");

const queueMixin = QueueMixin({
  connection: "amqp://localhost",
  asyncActions: true, // Enable auto generate .async version for actions
  localPublisher: false, // Enable/Disable call this.actions.callAsync to call remote async
});

broker.createService({
  name: "consumer",

  mixins: [queueMixin],

  settings: {
    amqp: {
      connection: "amqp://localhost", // You can also override setting from service setting
    },
  },

  actions: {
    hello: {
      // Enable queue for this action
      queue: {
        // Options for AMQP queue
        channel: {
          assert: {
            durable: true,
          },
          prefetch: 0,
        },
        consume: {
          noAck: false,
        },
      },
      params: {
        name: "string|convert:true|empty:false",
      },
      async handler(ctx) {
        this.logger.info(
          `[CONSUMER] PID: ${process.pid} Received job with name=${ctx.params.name}`
        );
        return new Promise((resolve) => {
          setTimeout(() => {
            this.logger.info(
              `[CONSUMER] PID: ${process.pid} Processed job with name=${ctx.params.name}`
            );
            return resolve(`hello ${ctx.params.name}`);
          }, 1000);
        });
      },
    },
  },
});
```

## Call async action to queue jobs

```js
const QueueMixin = require("moleculer-rabbitmq");

const queueMixin = QueueMixin({
  connection: "amqp://localhost",
  asyncActions: true, // Enable auto generate .async version for actions
  localPublisher: false, // Enable/Disable call this.actions.callAsync to call remote async
});

broker.createService({
  name: "publisher",

  mixins: [queueMixin],

  settings: {
    amqp: {
      connection: "amqp://localhost", // You can also override setting from service setting
    },
  },

  async started() {
    await broker.waitForServices("consumer");

    let name = 1;
    setInterval(async () => {
      const response = await broker.call("consumer.hello.async", {
        // `params` is the real param will be passed to original action
        params: {
          name,
        },
        // `options` is the real options will be passed to original action
        options: {
          timeout: 2000,
        },
      });
      this.logger.info(
        `[PUBLISHER] Called job with name=${name} response=${response}`
      );
      name++;
    }, 2000);
  },
});
```

# Examples

Take a look at [examples](examples) folder for more examples
- [Simple example](examples/simple) : Basic example
- [Local publisher example](examples/localPublisher) : Example with local publisher (allow publisher to create task event when consumer services is offline). Warning: if there are queue configuration difference between publisher and consumer, the queue configuration will be set follow the first one started. Will improve this in future update or please make a PR if you wanna.

# Roadmap

- [ ] Graceful shutdown queue
- [ ] Allow deduplicate message
- [ ] Implement retry logic for rabbitmq queue

# License

The project is available under the [MIT license](https://tldrlegal.com/license/mit-license).
