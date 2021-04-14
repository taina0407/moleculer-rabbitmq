# Build image

docker build -t moleculer-rabbitmq/rabbitmq:latest .

# Push image

docker push moleculer-rabbitmq/rabbitmq:latest

# Run container
docker run -d --name rabbitmq -p 15672:15672 -p 5672:5672 taina/rabbitmq:latest
