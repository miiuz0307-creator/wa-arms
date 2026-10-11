class Pool {
  constructor() {
    throw new Error('pg stub: no database in tests');
  }
}
module.exports = { Pool, types: { setTypeParser() {} } };
