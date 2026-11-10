FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server.js ./
COPY src/ ./src/
USER node
EXPOSE 8790
CMD ["node", "server.js"]
