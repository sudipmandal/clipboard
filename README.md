# Clipboard App

A bloat-free, simple, self-hosted, containerized clipboard app that can be accessed from any browser. The app uses SQLite3 as its database.

## Prerequisites

- Docker must be installed on your machine. You can download and install Docker from the [official Docker website](https://www.docker.com/get-started).

## QUICK DEPLOY
- Latest code is available as image on docker hub, self host it as follows

   ```bash
   docker run -d -p 3000:3000 --name clippy sudipthegreat:clipboard
   ```

   
   ```yaml
   version: '3.8'

   services:
     clipboard:
       image: sudipthegreat/clipboard:latest
       ports:
         - "3000:3000"
   ```

## BUILD FROM SOURCE

1. **Clone the repository:**
   ```bash
   git clone https://github.com/sudipmandal/clipboard.git
   cd clipboard
   ```

2. **Build the Docker image:**
   ```bash
   docker build -t clipboard .
   ```

3. **Run the Docker container:**
   ```bash
   docker run -d -p 3000:3000 --name clippy clipboard:latest
   ```

   Alternatively, you can use Docker Compose to run the container:

   Create a `docker-compose.yml` file with the following content:

   ```yaml
   version: '3.8'

   services:
     clipboard-app:
       image: clipboard
       build: .
       ports:
         - "3000:3000"
   ```

   Then run the following command to start the container:
   ```bash
   docker-compose up -d
   ```

4. **Open your browser:**
   Navigate to `http://<server-url>:3000` to see your application in action.

## License

This project is licensed under the GNU GPLv3 License.