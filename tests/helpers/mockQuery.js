// Mongoose query chains (Model.find(...).sort(...).skip(...).limit(...).populate(...))
// are awaited as a single expression. This builds a thenable stand-in whose
// chain methods all return itself and which resolves to `value` when awaited
// — enough to drive controller logic in tests without a real MongoDB.
const makeQuery = (value) => {
  const query = {
    sort: () => query,
    skip: () => query,
    limit: () => query,
    select: () => query,
    populate: () => query,
    then: (resolve, reject) => Promise.resolve(value).then(resolve, reject),
    catch: (reject) => Promise.resolve(value).catch(reject),
  };
  return query;
};

module.exports = { makeQuery };
