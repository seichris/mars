FROM node:22.23.4-alpine

WORKDIR /app
COPY . .

ENV PORT=8000
EXPOSE 8000

CMD ["node", "server.js"]
