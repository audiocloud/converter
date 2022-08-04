FROM node:current-alpine

RUN apk add --no-cache ffmpeg

WORKDIR /app

COPY package*.json /app/

RUN npm i

COPY . .

CMD [ "node", "index.mjs" ]
