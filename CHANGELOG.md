## v1.0.0
- [Breaking Change]
  - Queues in RabbitMQ created by v0.1.0 must be re-create because retry/deduplication feature cause queue configuration changed
  - Rename configuration to make it more relevant with amqplib configuration, please follow README to validate your configuration
    - queue.channel => queue.amqp
    - queue.channel.assert => queue.amqp.queueAssert
    - queue.consume => queue.amqp.consume
- [Add]
  - Add retry feature by RabbitMQ requeue or using [rabbitmq-delayed-message-exchange](https://github.com/rabbitmq/rabbitmq-delayed-message-exchange) plugin
  - Add deduplication feature using [rabbitmq-message-deduplication](https://github.com/noxdafox/rabbitmq-message-deduplication) plugin
- [Fix]
  - Fix bug not apply queue configuration when assert queue

## v0.1.0
- First release
