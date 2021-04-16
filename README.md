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
        amqp: {
          queueAssert: {
            durable: true,
          },
          consume: {
            noAck: false,
          },
          prefetch: 0,
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

# Retry failed jobs
By default, this plugin will not retry failed job. There are two option to enable retry logic: *RabbitMQ requeue* and using *[rabbitmq-delayed-message-exchange](https://github.com/rabbitmq/rabbitmq-delayed-message-exchange) plugin*

## RabbitMQ requeue
Set retry option to true when declare queue to enable Rabbitmq requeue.
Please note that the message will re requeue forever because *max_retry* is not available
```javascript
  actions: {
    hello: {
      queue: {
        retry: true, // Using rabbitmq default requeue logic
      },
      // ...
    },
  },
```

## Retry using *rabbitmq-delayed-message-exchange* plugins
**REQUIRE [rabbitmq-delayed-message-exchange](https://github.com/rabbitmq/rabbitmq-delayed-message-exchange) plugin to be install and enabled in RabbitMQ**

[Example RabbitMQ dockerfile](examples/rabbitmq/Dockerfile)

Example:
```javascript
  actions: {
    hello: {
      queue: {
        retryExchangeAssert: {
          durable: true, // (boolean) if true, the exchange will survive broker restarts. Defaults to true.
          autoDelete: false, // (boolean) if true, the exchange will be destroyed once the number of bindings for which it is the source drop to zero. Defaults to false.
          alternateExchange: null, // (string) an exchange to send messages to if this exchange can’t route them to any queues.
          arguments: { // additional arguments, usually parameters for some kind of broker-specific extension e.g., high availability, TTL
          },
        },
        retry: {
          max_retry: 3, // Max retry count, 3 mean if the first time failed, it will try 3 more times
          delay: (retry_count) => { // Number of miliseconds delay between each retry, could be a number or a function(retry_count) that return a number
            return retry_count * 1000;
          },
        },
      },
      // ...
    },
  },
```

# Deduplicate jobs
This plugin allow you to avoid dupplicate task using `dedupHash` option that can be number, string or function(ctx) that return a number or string
To get this feature to work, you have to install [rabbitmq-message-deduplication](https://github.com/noxdafox/rabbitmq-message-deduplication) plugin.
And please aware that using this feature may cause decrease in queue performance

[Example RabbitMQ dockerfile](examples/rabbitmq/Dockerfile)
[Example plugin usage with deduplication](examples/deduplication)

# Plugin Configuration

## Mixin configuration
```javascript
connection: "amqp://localhost", // (String|Object) Required. connection string or object, passed to amqplib.connect (You can also set this on broker.createService settings.amqp.connection parameter)
asyncActions: true, // (Boolean) Optional, default: false. Enable auto generate .async version for actions
```

## Action configuration
```javascript
queue: {
  amqp: {
    queueAssert: { // Options for job queue (Ref: http://www.squaremobius.net/amqp.node/channel_api.html#channel_assertQueue)
      exclusive: false, // (boolean) if true, scopes the queue to the connection (defaults to false)
      durable: true, // (boolean) if true, the queue will survive broker restarts, modulo the effects of exclusive and autoDelete; this defaults to true if not supplied, unlike the others
      autoDelete: false, // (boolean) if true, the queue will be deleted when the number of consumers drops to zero (defaults to false)
      arguments: { // additional arguments, usually parameters for some kind of broker-specific extension e.g., high availability, TTL
        "x-message-deduplication": true, // Preserve for deduplication feature
      },
    },
    retryExchangeAssert: { // Options for retry exchange (Ref: http://www.squaremobius.net/amqp.node/channel_api.html#channel_assertExchange)
      durable: true, // (boolean) if true, the exchange will survive broker restarts. Defaults to true.
      autoDelete: false, // (boolean) if true, the exchange will be destroyed once the number of bindings for which it is the source drop to zero. Defaults to false.
      alternateExchange: null, // (string) an exchange to send messages to if this exchange can’t route them to any queues.
      arguments: { // additional arguments, usually parameters for some kind of broker-specific extension e.g., high availability, TTL
        "arguments.x-delayed-type": "direct", // Set by this plugin
        "x-message-deduplication": true, // Preserve for deduplication feature
      },
    },
    consume: { // Options for consumer (Ref: http://www.squaremobius.net/amqp.node/channel_api.html#channel_consume)
      noAck: false,
    },
    prefetch: 0, // Set the prefetch count for this channel
  },
  retry: { // (Boolean|Object) : Enable or disable retry option
    max_retry: 0, // Max retry count
    delay: 0, // Delay in ms each retry
  },
  dedupHash: null, // (Number|String|Function(ctx)) Hash or function to calculate hash to deduplicate task
}
```

# Examples

Take a look at [examples](examples) folder for more examples
- [Simple example](examples/simple) : Example for basic usage
- [Retry example](examples/retry) : Example with retry logic
- [Deduplication example](examples/deduplication) : Example with deduplicate message feature
- [Graceful shutdown example](examples/graceful_shutdown) : Example with moleculer graceful shutdown feature

# Checklist

- [x] Implement retry logic for rabbitmq queue
- [x] Allow deduplicate message
- [X] Graceful shutdown queue
- [ ] Test & Coverage

# License

The project is available under the [MIT license](https://tldrlegal.com/license/mit-license).
