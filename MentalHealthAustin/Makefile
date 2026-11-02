# Convenience targets for the frontend (see README.md for the full local-run steps).
MAIN_BRANCH := main

install:
	npm ci

start:
	npm run start

pull:
	git pull origin $(MAIN_BRANCH)

push:
	git push origin $(MAIN_BRANCH)

install-packages:
	npm install react-icons --save
	npm install react-router-dom --save
	npm install --save chart.js react-chartjs-2

# build frontend
build-frontend :
	docker build -t frontend .

run-frontend:
	docker run -dp 127.0.0.1:3000:3000 frontend