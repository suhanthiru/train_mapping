# Static analytics dashboard (Chart.js). Reads the live services over CORS.
FROM node:24-slim
WORKDIR /app
COPY index.html app.js serve.mjs ./
EXPOSE 4174
CMD ["node", "serve.mjs"]
