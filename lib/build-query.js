'use strict';

//TODO: move to dbal

const _ = require('lodash');
const parseType = require('./parse-type');

const isAttribute = (model, field) =>
  _.has(model.allAttributes, field) || model.primaryKey === field || field === 'id';

// Fields holding credentials or one-time tokens, on any model. A filter may only test one for equality
// on the queried model itself: through a relation, with a pattern or range operator, as a sort key or
// in a `_q` search, it lets a caller recover the value piece by piece.
const SECRET_ATTRIBUTES = [
  'password',
  'resetPasswordToken',
  'confirmationToken',
  'registrationToken',
  'credentials',
  'erp_credentials',
  'default_shipping_credentials',
  'shipping_credentials',
  'client_secret',
  'pending_context',
];
const SECRET_SAFE_OPERATORS = ['eq', 'ne', 'in', 'nin', 'null'];

// Same answer as for a field that does not exist, so the reply does not reveal which fields are secret.
const unknownFieldError = field => {
  const err = new Error(
    `Your filters contain a field '${field}' that doesn't appear on your model definition nor its relations`
  );

  err.status = 400;
  return err;
};

const assertNoSecretLookup = ({ field, operator }) => {
  const secretIndex = field.split('.').findIndex(part => SECRET_ATTRIBUTES.includes(part));

  if (secretIndex === -1) return;
  if (secretIndex > 0 || !SECRET_SAFE_OPERATORS.includes(operator)) {
    throw unknownFieldError(field);
  }
};

/**
 * Returns the model, attribute name and association from a path of relation
 * @param {Object} options - Options
 * @param {Object} options.model - Strapi model
 * @param {string} options.field - path of relation / attribute
 */
const getAssociationFromFieldKey = ({ model, field }) => {
  const fieldParts = field.split('.');

  let tmpModel = model;
  let association;
  let attribute;

  for (let i = 0; i < fieldParts.length; i++) {
    const part = fieldParts[i];
    attribute = part;

    const assoc = tmpModel.associations.find(ast => ast.alias === part);

    if (assoc) {
      association = assoc;
      tmpModel = strapi.db.getModelByAssoc(assoc);
      continue;
    }

    if (!assoc && (!isAttribute(tmpModel, part) || i !== fieldParts.length - 1)) {
      throw unknownFieldError(field);
    }
  }

  return {
    association,
    model: tmpModel,
    attribute,
  };
};

/**
 * Cast an input value
 * @param {Object} options - Options
 * @param {string} options.type - type of the atribute
 * @param {*} options.value - value tu cast
 * @param {string} options.operator - name of operator
 */
const castInput = ({ type, value, operator }) => {
  return Array.isArray(value)
    ? value.map(val => castValue({ type, operator, value: val }))
    : castValue({ type, operator, value: value });
};

/**
 * Cast basic values based on attribute type
 * @param {Object} options - Options
 * @param {string} options.type - type of the atribute
 * @param {*} options.value - value tu cast
 * @param {string} options.operator - name of operator
 */
const castValue = ({ type, value, operator }) => {
  if (operator === 'null') return parseType({ type: 'boolean', value });
  return parseType({ type, value });
};

/**
 *
 * @param {Object} options - Options
 * @param {string} options.model - The model
 * @param {string} options.field - path of relation / attribute
 */
const normalizeFieldName = ({ model, field }) => {
  const fieldPath = field.split('.');
  return _.last(fieldPath) === 'id'
    ? _.initial(fieldPath)
        .concat(model.primaryKey)
        .join('.')
    : fieldPath.join('.');
};

const BOOLEAN_OPERATORS = ['or', 'and'];

const hasDeepFilters = ({ where = [], sort = [] }, { minDepth = 1 } = {}) => {
  // A query uses deep filtering if some of the clauses contains a sort or a match expression on a field of a relation

  // We don't use minDepth here because deep sorting is limited to depth 1
  const hasDeepSortClauses = sort.some(({ field }) => field.includes('.'));

  const hasDeepWhereClauses = where.some(({ field, operator, value }) => {
    if (BOOLEAN_OPERATORS.includes(operator)) {
      return value.some(clauses => hasDeepFilters({ where: clauses }));
    }

    return field.split('.').length > minDepth;
  });

  return hasDeepSortClauses || hasDeepWhereClauses;
};

const normalizeWhereClauses = (whereClauses, { model }) => {
  return whereClauses
    .filter(({ field, value }) => {
      if (_.isNull(value)) {
        return false;
      } else if (_.isUndefined(value)) {
        strapi.log.warn(`The value of field: '${field}', in your where filter, is undefined.`);
        return false;
      }
      return true;
    })
    .map(({ field, operator, value }) => {
      if (BOOLEAN_OPERATORS.includes(operator)) {
        return {
          field,
          operator,
          value: value.map(clauses => normalizeWhereClauses(clauses, { model })),
        };
      }

      assertNoSecretLookup({ field, operator });

      const { model: assocModel, attribute } = getAssociationFromFieldKey({
        model,
        field,
      });

      const { type } = _.get(assocModel, ['allAttributes', attribute], {});

      // cast value or array of values
      const castedValue = castInput({ type, operator, value });

      return {
        field: normalizeFieldName({ model, field }),
        operator,
        value: castedValue,
      };
    });
};

const normalizeSortClauses = (clauses, { model }) => {
  clauses.forEach(({ field }) => assertNoSecretLookup({ field }));

  const normalizedClauses = clauses.map(({ field, order }) => ({
    field: normalizeFieldName({ model, field }),
    order,
  }));

  normalizedClauses.forEach(({ field }) => {
    const fieldDepth = field.split('.').length - 1;
    if (fieldDepth === 1) {
      // Check if the relational field exists
      getAssociationFromFieldKey({ model, field });
    } else if (fieldDepth > 1) {
      const err = new Error(
        `Sorting on ${field} is not possible: you cannot sort at a depth greater than 1`
      );

      err.status = 400;
      throw err;
    }
  });

  return normalizedClauses;
};

/**
 *
 * @param {Object} options - Options
 * @param {Object} options.model - The model for which the query will be built
 * @param {Object} options.filters - The filters for the query (start, sort, limit, and where clauses)
 * @param {Object} options.rest - In case the database layer requires any other params pass them
 */
const buildQuery = ({ model, filters = {}, ...rest }) => {
  const { where, sort } = filters;

  // Validate query clauses
  if ([where, sort].some(Array.isArray)) {
    if (hasDeepFilters({ where, sort }, { minDepth: 2 })) {
      strapi.log.warn(
        'Deep filtering queries should be used carefully (e.g Can cause performance issues).\nWhen possible build custom routes which will in most case be more optimised.'
      );
    }

    if (sort) {
      filters.sort = normalizeSortClauses(sort, { model });
    }

    if (where) {
      // Cast where clauses to match the inner types
      filters.where = normalizeWhereClauses(where, { model });
    }
  }

  // call the ORM's buildQuery implementation
  return strapi.db.connectors.get(model.orm).buildQuery({ model, filters, ...rest });
};

module.exports = {
  buildQuery,
  hasDeepFilters,
  SECRET_ATTRIBUTES,
};
