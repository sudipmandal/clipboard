<template>
  <div id="app">
    <div class="chat-container">
      <div class="chat-messages">
        <ChatMessage
          v-for="(message, index) in messages"
          :key="index"
          :message="message"
        />
      </div>
      <ChatInput @sendMessage="addMessage" />
    </div>
  </div>
</template>

<script>
import ChatInput from './components/ChatInput.vue';
import ChatMessage from './components/ChatMessage.vue';

export default {
  name: 'App',
  components: {
    ChatInput,
    ChatMessage,
  },
  data() {
    return {
      messages: [],
    };
  },
  methods: {
    addMessage(message) {
      this.messages.push(message);
    },
  },
};
</script>

<style>
html, body, #app {
  height: 100%;
  margin: 0;
  padding: 0;
}

#app {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  height: 100%;
  font-family: Avenir, Helvetica, Arial, sans-serif;
  text-align: center;
  color: #2c3e50;
}

.chat-container {
  display: flex;
  flex-direction: column;
  flex: 1;
  border: 1px solid #ccc;
  border-radius: 5px;
  overflow: hidden;
}

.chat-messages {
  flex: 1;
  overflow-y: auto;
  padding: 10px;
  background-color: #f9f9f9;
}

.chat-input {
  border-top: 1px solid #ccc;
  background-color: #fff;
}
</style>