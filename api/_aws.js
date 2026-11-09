// Optional AWS Always Free adapters. Every call stays off unless AWS_REGION,
// credentials, and that service's own setting are present. No Bedrock and no
// other paid APIs. aws4fetch is imported only when a signed call is made, so
// demo mode does not need the package loaded.

export const MAX_STATE_BYTES = 20 * 1024; // 20 WCU at 1 KB per unit, under the 25 WCU free cap
export const MAX_QUEUE_BYTES = 200_000; // under the 256 KB SQS message limit
export const METRICS = ['AgentRunErrors', 'QueueFailures'];

const REGION = /^[a-z]{2}-[a-z]+-\d{1,2}$/;
const TABLE = /^[A-Za-z0-9_.-]{3,255}$/;
const NAMESPACE = /^[A-Za-z0-9_.:#-]{1,255}$/;

export function awsReady() {
  return REGION.test(process.env.AWS_REGION || '')
    && Boolean(process.env.AWS_ACCESS_KEY_ID)
    && Boolean(process.env.AWS_SECRET_ACCESS_KEY);
}

export function queueUrl() {
  const raw = process.env.AWS_SQS_QUEUE_URL || '';
  let url;
  try { url = new URL(raw); } catch { return null; }
  const region = process.env.AWS_REGION;
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null;
  if (url.hostname !== `sqs.${region}.amazonaws.com`) return null;
  if (!/^\/\d{12}\/[A-Za-z0-9_-]{1,80}$/.test(url.pathname)) return null;
  return url.toString().replace(/\/$/, '');
}

export function tableName() {
  const name = process.env.AWS_DYNAMODB_TABLE || '';
  return TABLE.test(name) ? name : null;
}

export function metricNamespace() {
  const name = process.env.AWS_CLOUDWATCH_NAMESPACE || '';
  if (!NAMESPACE.test(name) || name.startsWith('AWS/')) return null;
  return name;
}

export const sqsEnabled = () => awsReady() && Boolean(queueUrl());
export const dynamoEnabled = () => awsReady() && Boolean(tableName());
export const metricsEnabled = () => awsReady() && Boolean(metricNamespace());

async function signedFetch(url, { service, target, body }) {
  const { AwsClient } = await import('aws4fetch');
  const aws = new AwsClient({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    sessionToken: process.env.AWS_SESSION_TOKEN || undefined,
    region: process.env.AWS_REGION,
    service,
    retries: 0,
  });
  return aws.fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-amz-json-1.0',
      'x-amz-target': target,
    },
    body,
  });
}

async function awsOk(response) {
  if (response.ok) return response.json().catch(() => ({}));
  const err = new Error('aws request failed');
  err.status = response.status;
  throw err;
}

export async function sqsSend(body) {
  const url = queueUrl();
  const response = await signedFetch(url, {
    service: 'sqs',
    target: 'AmazonSQS.SendMessage',
    body: JSON.stringify({ QueueUrl: url, MessageBody: body }),
  });
  return awsOk(response);
}

export async function sqsReceive() {
  const url = queueUrl();
  const response = await signedFetch(url, {
    service: 'sqs',
    target: 'AmazonSQS.ReceiveMessage',
    body: JSON.stringify({
      QueueUrl: url,
      MaxNumberOfMessages: 1,
      WaitTimeSeconds: 0,
      VisibilityTimeout: 90,
      MessageSystemAttributeNames: ['ApproximateReceiveCount'],
    }),
  });
  return awsOk(response);
}

export async function sqsDelete(receiptHandle) {
  const url = queueUrl();
  const response = await signedFetch(url, {
    service: 'sqs',
    target: 'AmazonSQS.DeleteMessage',
    body: JSON.stringify({ QueueUrl: url, ReceiptHandle: receiptHandle }),
  });
  return awsOk(response);
}

export async function sqsRelease(receiptHandle) {
  const url = queueUrl();
  const response = await signedFetch(url, {
    service: 'sqs',
    target: 'AmazonSQS.ChangeMessageVisibility',
    body: JSON.stringify({ QueueUrl: url, ReceiptHandle: receiptHandle, VisibilityTimeout: 0 }),
  });
  return awsOk(response);
}

export async function dynamoGet(profile) {
  const response = await signedFetch(`https://dynamodb.${process.env.AWS_REGION}.amazonaws.com/`, {
    service: 'dynamodb',
    target: 'DynamoDB_20120810.GetItem',
    body: JSON.stringify({
      TableName: tableName(),
      Key: { pk: { S: profile } },
      ConsistentRead: false,
      ProjectionExpression: 'updatedAt, #s',
      ExpressionAttributeNames: { '#s': 'state' },
    }),
  });
  return awsOk(response);
}

export async function dynamoPut(profile, stateJson, updatedAt) {
  const response = await signedFetch(`https://dynamodb.${process.env.AWS_REGION}.amazonaws.com/`, {
    service: 'dynamodb',
    target: 'DynamoDB_20120810.PutItem',
    body: JSON.stringify({
      TableName: tableName(),
      Item: {
        pk: { S: profile },
        updatedAt: { N: String(updatedAt) },
        state: { S: stateJson },
      },
    }),
  });
  return awsOk(response);
}

let waiter = null;
let tail = Promise.resolve();

export function bindWaitUntil(fn) {
  waiter = typeof fn === 'function' ? fn : null;
}

export function metricsSettled() {
  return tail;
}

export function emitMetric(name) {
  if (!metricsEnabled() || !METRICS.includes(name)) return;
  const pending = sendMetric(name).catch(() => {});
  tail = tail.then(() => pending).catch(() => {});
  try { waiter?.(pending); } catch { /* the response must not wait on metrics */ }
}

async function sendMetric(name) {
  await signedFetch(`https://monitoring.${process.env.AWS_REGION}.amazonaws.com/`, {
    service: 'monitoring',
    target: 'GraniteServiceVersion20100801.PutMetricData',
    body: JSON.stringify({
      Namespace: metricNamespace(),
      MetricData: [{
        MetricName: name,
        Timestamp: new Date().toISOString(),
        Value: 1,
        Unit: 'Count',
      }],
    }),
  });
}
