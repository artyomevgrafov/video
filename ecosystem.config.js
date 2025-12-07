module.exports = {
  apps: [
    {
      name: 'lan-video-server',
      script: 'server.js',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      watch: [ 'server.js', 'public' ],
      ignore_watch: [ 'node_modules', 'logs' ],
      env: {
        PORT: 8081,
        HOST: '0.0.0.0',
        NODE_ENV: 'production'
      }
    }
  ]
};
