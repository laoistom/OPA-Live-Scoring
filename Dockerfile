FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

RUN chmod +x docker/start.sh

EXPOSE 3000

CMD ["sh", "-c", "./docker/start.sh"]
