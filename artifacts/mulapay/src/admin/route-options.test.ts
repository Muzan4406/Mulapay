import assert from 'node:assert/strict';
import { test } from 'node:test';
import { routeOperatorOptions } from './route-options';

test('admin provider choices expose the canonical provider identifiers by country', () => {
  assert.deepEqual(
    routeOperatorOptions('DRIMPAY', 'TG').map(({ operator, providerOperator }) => [operator, providerOperator]),
    [['Mixx by Yas', 'tmoney'], ['Moov Money', 'moov']],
  );
  assert.deepEqual(
    routeOperatorOptions('DRIMPAY', 'BJ').map(({ operator, providerOperator }) => [operator, providerOperator]),
    [['MTN MoMo', 'mtn'], ['Moov Money', 'moov'], ['Celtiis Money', 'celtiis']],
  );
  assert.deepEqual(
    routeOperatorOptions('DRIMPAY', 'CI').map(({ operator, providerOperator }) => [operator, providerOperator]),
    [['MTN MoMo', 'mtn'], ['Orange Money', 'orange'], ['Wave', 'wave'], ['Moov Money', 'moov']],
  );
  assert.deepEqual(
    routeOperatorOptions('DRIMPAY', 'BF').map(({ operator, providerOperator }) => [operator, providerOperator]),
    [['Orange Money', 'orange'], ['Moov Money', 'moov'], ['Wave', 'wave']],
  );
  assert.deepEqual(
    routeOperatorOptions('DRIMPAY', 'SN').map(({ operator, providerOperator }) => [operator, providerOperator]),
    [['Orange Money', 'orange'], ['Wave', 'wave'], ['Free Money', 'free']],
  );
  assert.deepEqual(
    routeOperatorOptions('DRIMPAY', 'ML').map(({ operator, providerOperator }) => [operator, providerOperator]),
    [['Orange Money', 'orange'], ['Moov Money', 'moov']],
  );
  assert.deepEqual(routeOperatorOptions('DRIMPAY', 'NE'), []);
  assert.deepEqual(
    routeOperatorOptions('ASHTECHPAY', 'NE').map(({ operator, providerOperator }) => [operator, providerOperator]),
    [['Airtel Money', 'Airtel Money']],
  );
});
