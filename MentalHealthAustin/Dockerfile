# Frontend dev-server image. Build with `docker build -t frontend .`; set REACT_APP_API_URL at build time to point at the API.
FROM node:18-alpine
WORKDIR /app
COPY . .

# install dependencies
COPY package*.json ./
RUN npm ci

# add all files
COPY . ./

# start
CMD npm start
