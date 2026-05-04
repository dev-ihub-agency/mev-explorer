module.exports = {
  apps: [
    {
      name: "mev-crawler",
      script: "crawler.js",
      args: "--watch",
      cwd: "/home/ubuntu/projects/mev-explorer",
      node_args: "--env-file=.env",
      autorestart: true,
      max_restarts: 50,
      restart_delay: 5000,
      max_memory_restart: "500M",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
    },
  ],
};
