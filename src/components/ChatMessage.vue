<template>
  <div class="chat-message">
    <div v-html="message"></div>
    <button class="delete-button" @click="deleteMessage">Delete</button>
    <button class="copy-button" @click="copyToClipboard">{{ copyButtonLabel }}</button>
  </div>
</template>

<script>
export default {
  props: {
    message: {
      type: String,
      required: true,
    },
    id: {
      type: Number,
      required: true,
    },
  },
  data() {
    return {
      copyButtonLabel: 'Text Copy',
    };
  },
  methods: {
    deleteMessage() {
      this.$emit('deleteMessage', this.id);
    },
    copyToClipboard() {
      const el = document.createElement('textarea');
      el.value = this.message.replace(/<[^>]*>?/gm, ''); // Strip HTML tags
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      document.body.removeChild(el);

      // Change button label and color
      this.copyButtonLabel = 'Done';
      const copyButton = this.$el.querySelector('.copy-button');
      copyButton.style.backgroundColor = '#006400'; // Dark green

      // Revert button label and color after 2 seconds
      setTimeout(() => {
        this.copyButtonLabel = 'Text Copy';
        copyButton.style.backgroundColor = '#4CAF50'; // Original green
      }, 2000);
    },
  },
};
</script>

<style>
.chat-message {
  position: relative;
  margin-bottom: 10px;
  padding: 10px;
  background-color: #fff;
  border-radius: 5px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
}

.chat-message img {
  max-width: 100%;
  border-radius: 5px;
}

.delete-button, .copy-button {
  position: absolute;
  top: 10px;
  right: 10px;
  background-color: #ff4d4d;
  color: white;
  border: none;
  border-radius: 5px;
  padding: 5px 10px;
  cursor: pointer;
}

.copy-button {
  right: 90px; /* Adjust position to avoid overlap with delete button */
  background-color: #4CAF50;
}

.delete-button:hover {
  background-color: #ff1a1a;
}

.copy-button:hover {
  background-color: #45a049;
}
</style>