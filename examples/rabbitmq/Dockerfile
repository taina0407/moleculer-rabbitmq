FROM rabbitmq:3-management

ADD https://github.com/noxdafox/rabbitmq-message-deduplication/releases/download/0.5.0/elixir-1.10.4.ez /opt/rabbitmq/plugins/
ADD https://github.com/noxdafox/rabbitmq-message-deduplication/releases/download/0.5.0/rabbitmq_message_deduplication-0.5.0.ez /opt/rabbitmq/plugins/

ADD https://github.com/rabbitmq/rabbitmq-delayed-message-exchange/releases/download/3.8.9/rabbitmq_delayed_message_exchange-3.8.9-0199d11c.ez /opt/rabbitmq/plugins/

RUN chown rabbitmq:rabbitmq /opt/rabbitmq/plugins/*.ez \
    && rabbitmq-plugins enable --offline rabbitmq_message_deduplication \
    && rabbitmq-plugins enable --offline rabbitmq_delayed_message_exchange
