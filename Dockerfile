FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY . .
RUN mkdir -p /app/data /app/backups /app/uploads

EXPOSE 8094

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8094)+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
