import mongoose from 'mongoose';
import dns from 'node:dns';

let isConnected = false;
let listenersRegistered = false;

const configureMongoDns = () => {
    const servers = (process.env.MONGODB_DNS_SERVERS || '')
        .split(',')
        .map((server) => server.trim())
        .filter(Boolean);

    if (servers.length > 0) dns.setServers(servers);
};

const connectDB = async () => {
    try {
        if (mongoose.connection.readyState === 1) {
            isConnected = true;
            return mongoose.connection;
        }
        if (!process.env.MONGODB_URI) {
            console.log('⚠️  No MongoDB URI found. Running in in-memory mode.');
            return null;
        }

        configureMongoDns();

        const conn = await mongoose.connect(process.env.MONGODB_URI, {
            serverSelectionTimeoutMS: Number(process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS || 5000),
            maxPoolSize: Number(process.env.MONGODB_MAX_POOL_SIZE || 20),
            minPoolSize: Number(process.env.MONGODB_MIN_POOL_SIZE || 1)
        });

        console.log(`✅ MongoDB Connected: ${conn.connection.host}`);
        isConnected = true;
        
        if (!listenersRegistered) {
            listenersRegistered = true;
            mongoose.connection.on('error', (err) => {
                console.error('MongoDB connection error:', err.message);
                isConnected = false;
            });
            mongoose.connection.on('disconnected', () => {
                isConnected = false;
            });
            process.on('SIGINT', async () => {
                await mongoose.connection.close();
                process.exit(0);
            });
        }

        return conn;
    } catch (error) {
        console.log(`⚠️  MongoDB connection failed: ${error.message}`);
        console.log('⚠️  Running in in-memory mode. See MONGODB_SETUP.md for database setup.');
        isConnected = false;
        return null;
    }
};

const disconnectDB = async () => {
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
    isConnected = false;
};

export { connectDB, disconnectDB, isConnected };
export default connectDB;
