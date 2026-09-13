require('dotenv').config();

const mongoose = require('mongoose');

const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  console.error('Missing MONGODB_URI. Add it to .env before clearing the database.');
  process.exit(1);
}

async function clearDatabase() {
  await mongoose.connect(MONGODB_URI);

  const collections = ['products', 'cities', 'customers', 'vendors', 'ledgerentries'];
  for (const name of collections) {
    try {
      await mongoose.connection.db.collection(name).deleteMany({});
      console.log(`Cleared ${name}`);
    } catch (error) {
      if (error.codeName !== 'NamespaceNotFound') throw error;
    }
  }

  await mongoose.disconnect();
  console.log('Database is empty.');
}

clearDatabase().catch(error => {
  console.error(error);
  process.exit(1);
});
