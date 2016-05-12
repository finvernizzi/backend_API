module.exports.__DATABASE_NAME__ = "test";
module.exports.__DATABASE_HOST__ = "127.0.0.1";
// Port we should listen on
module.exports.__LISTEN_PORT__ = process.env.meta_port || 8003;
module.exports.LOG_FILE = "./log/backend_API.log";
module.exports.STATIC_CONTENT_DIR = "./public"; 
