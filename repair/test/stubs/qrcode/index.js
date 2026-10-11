module.exports = { toDataURL: async (t) => 'data:image/png;base64,' + Buffer.from(String(t)).toString('base64') };
