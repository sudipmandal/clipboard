<template>
  <div id="app">
    <div class="chat-container">
      <div class="chat-messages" ref="chatMessages">
        <ChatMessage
          v-for="(message, index) in messages"
          :id="message.id"
          :message="message"
          @deleteMessage="deleteMessage"
        />
      </div>
      <ChatInput @sendMessage="addMessage" />
    </div>
  </div>
</template>

<script>
import axios from 'axios';
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
    async fetchMessages() {
      try {
        const response = await axios.get('/api/messages');
        console.log('Fetched messages:', response); // Debugging line
        this.messages = response.data;
        this.scrollToBottom();
      } catch (error) {
        console.error('Error fetching messages:', error);
      }
    },
    async addMessage(message) {
      try {
       // const response = await axios.post('/api/messages', message);
        this.messages.push(message);
        this.scrollToBottom();
      } catch (error) {
        console.error('Error adding message:', error);
      }
    },
    async deleteMessage(messageId) {
      try {
        await axios.delete(`/api/messages/${messageId}`);
        this.messages = this.messages.filter(message => message.id !== messageId);
      } catch (error) {
        console.error('Error deleting message:', error);
      }
    },
    scrollToBottom() {
      this.$nextTick(() => {
        const chatMessages = this.$refs.chatMessages;
        chatMessages.scrollTop = chatMessages.scrollHeight;
      });
    },
  },
  mounted() {
    this.fetchMessages();
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