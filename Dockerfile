FROM node:20-alpine

# Install dumb-init for proper signal handling
RUN apk add --no-cache dumb-init

WORKDIR /app

# Install dependencies first (layer cache)
COPY package.json ./
RUN npm install --omit=dev

# Copy source
COPY backend/ ./backend/
COPY public/  ./public/

# Create logs dir
RUN mkdir -p logs

# Non-root user for security
RUN addgroup -S buzzerbet && adduser -S buzzerbet -G buzzerbet
RUN chown -R buzzerbet:buzzerbet /app
USER buzzerbet

EXPOSE 3000

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "backend/server.js"]
