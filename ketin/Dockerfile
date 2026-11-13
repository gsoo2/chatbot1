FROM node:22-slim
WORKDIR /app
COPY package.json server.js ./
COPY public ./public
ENV DATA_DIR=/data PORT=3000
VOLUME /data
EXPOSE 3000
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
