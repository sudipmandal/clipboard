# Clipboard App

A bloat free simple selfhosted containerized clipboard app that can be accessed from any browser. App uses sqlite3 as its database and runs as a single container.

## Docker Instructions

1. **Build the Docker image:**
   ```bash
   docker build -t clipboard-app .
   ```

2. **Run the Docker container:**
   ```bash
   docker run -d -p 80:80 --name clipboard-app clipboard-vuejs-app
   ```

   Alternatively, you can use Docker Compose to run the container:

   Create a `docker-compose.yml` file with the following content:

   ```yaml
   version: '3.8'

   services:
     clipboard-app:
       image: clipboard-vuejs-app
       build: .
       ports:
         - "80:80"
   ```

   Then run the following command to start the container:
   ```bash
   docker-compose up -d
   ```

3. **Open your browser:**
   Navigate to `http://<server-url>` to see your application in action.

## Usage

- Modify the `src/components/ChatInput.vue` file to change the chat input behavior.
- Modify the `src/components/ChatMessage.vue` file to change the chat message display.
- Add additional components in the `src/components` directory as needed.
- Update styles in the `src/assets` directory.

## License

This project is licensed under the MIT License.