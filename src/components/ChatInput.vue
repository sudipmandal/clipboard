<template>
  <div class="chat-input">
    <quill-editor
      v-model:value="message"
      :options="editorOptions"
      @blur="onBlur"
    />
    <button @click="sendMessage">Send</button>
  </div>
</template>

<script>
import { quillEditor } from 'vue3-quill';
import axios from 'axios';

export default {
  components: {
    quillEditor,
  },
  data() {
    return {
      message: '',
      editorOptions: {
        placeholder: 'Type a message...',
        modules: {
          toolbar: [
            [{ 'header': [1, 2, false] }],
            ['bold', 'italic', 'underline'],
            ['image', 'code-block'],
            [{ 'list': 'ordered' }, { 'list': 'bullet' }],
            ['clean']
          ],
          clipboard: {
            matchVisual: false,
          },
        },
      },
    };
  },
  methods: {
    async sendMessage() {
      console.log('Message:', this.message); // Debugging line
      if (this.message.trim()) {
        try {
          const response = await axios.post('/api/messages', {
            text: this.message,
          });
          console.log('Message saved:', response.data);
          this.$emit('sendMessage',JSON.parse(JSON.stringify(this.message)) );
          this.message = '';
        } catch (error) {
          console.error('Error saving message:', error);
        }
      }
    },
    onBlur() {
      // Handle blur event if needed
    },
  },
};
</script>

<style>
.chat-input {
  display: flex;
  flex-direction: column;
  padding: 10px;
  border-top: 1px solid #ccc;
  background-color: #fff;
}

.chat-input .ql-container {
  flex: 1;
  height: 150px;
  border: 1px solid #ccc;
  border-radius: 5px;
  margin-bottom: 10px;
}

.chat-input button {
  padding: 10px 20px;
  border: none;
  background-color: #42b983;
  color: white;
  border-radius: 5px;
  cursor: pointer;
}
</style>