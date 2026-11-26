const mongoose = require("mongoose");

// Transactions are used for registration and login, so MongoDB must run
// as a replica set (MongoDB Atlas always does).
const connectDB = async () => {
  const connection = await mongoose.connect(process.env.MONGO_URI, {
    serverSelectionTimeoutMS: Number(process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS) || 15000,
    maxPoolSize: Number(process.env.MONGO_MAX_POOL_SIZE) || 20,
  });

  console.log(`MongoDB connected: ${connection.connection.host}`);

  mongoose.connection.on("error", (error) => {
    console.error("MongoDB connection error:", error.message);
  });

  await require("../models/githubInstallation.model")
    .migrateIndexes()
    .catch((error) => {
      console.error("GitHub installation indexes could not be updated:", error.message);
    });

  return connection;
};

module.exports = connectDB;
