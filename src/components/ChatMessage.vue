<template>
  <div class="chat-message">
    <div v-html="message"></div>
    <button class="delete-button" @click="deleteMessage">Delete</button>
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
  methods: {
    deleteMessage() {
      this.$emit('deleteMessage', this.id);
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

.delete-button {
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

.delete-button:hover {
  background-color: #ff1a1a;
}
</style>