# Packaged demo: builds the static web app and serves it. Contracts already live on Aevum Testnet
# (addresses in deployments/deployments.json), so no keys are needed inside the image.
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY shared ./shared
COPY deployments ./deployments
COPY web ./web
RUN npx vite build web

FROM nginx:1.27-alpine
COPY --from=build /app/web/dist /usr/share/nginx/html
EXPOSE 80
