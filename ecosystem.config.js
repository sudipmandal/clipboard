module.exports = {
  apps: [
    {
      name: 'backend',
      script: 'backend/server.js',
      watch: true,
    },
    {
      name: 'nginx',
      script: 'nginx',
      args: '-g "daemon off;"',
    },
  ],
};