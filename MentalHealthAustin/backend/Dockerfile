# Backend API image. DATABASE_URL selects the database (SQLite file by default); PORT defaults to 5000.
FROM python:latest
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update -y
RUN apt-get install -y python3
RUN apt-get install -y python3-pip python3-dev build-essential vim

WORKDIR /backend

COPY requirements.txt API\requirements.txt

RUN pip3 install --upgrade pip
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Bind to all interfaces inside the container; PORT defaults to 5000.
ENV HOST=0.0.0.0
CMD python3 app.py