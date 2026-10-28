FROM node:22-slim
WORKDIR /app
COPY . .
ENV NODE_ENV=production
ENV DB_PATH=/app/data/openstore.db
EXPOSE 3000
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
