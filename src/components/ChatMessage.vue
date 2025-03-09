<template>
    <div class="chat-message">
      <div v-if="message.type === 'text'" v-html="message.text"></div>
      <div v-if="message.type === 'image'">
        <img :src="message.text" alt="Image" />
      </div>
    </div>
  </template>
  
  <script>
  export default {
    props: {
      message: {
        type: Object,
        required: true,
      },
    },
  };
  </script>
  
  <style>
  .chat-message {
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
  </style>