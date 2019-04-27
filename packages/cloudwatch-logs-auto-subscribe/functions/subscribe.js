const AWS = require('aws-sdk')
const cloudWatchLogs = new AWS.CloudWatchLogs()
const lambda = new AWS.Lambda()
const uuid = require('uuid/v4')

const { PREFIX, EXCLUDE_PREFIX, DESTINATION_ARN, FILTER_NAME, FILTER_PATTERN, ROLE_ARN } = process.env
const isLambda = DESTINATION_ARN.startsWith('arn:aws:lambda')

const filterName = FILTER_NAME || 'ship-logs'
const filterPattern = FILTER_PATTERN || ''

module.exports.existingLogGroups = async () => {
  const loop = async (nextToken) => {
    const req = {
      nextToken: nextToken
    }
    const resp = await cloudWatchLogs.describeLogGroups(req).promise()
    const logGroups = resp.logGroups.filter(x =>
      !x.logGroupName.startsWith(EXCLUDE_PREFIX) &&
      x.logGroupName.startsWith(PREFIX))

    for (const { logGroupName } of logGroups) {
      const subFilterReq = {
        logGroupName: logGroupName
      }
      const subFilterResp = await cloudWatchLogs.describeSubscriptionFilters(subFilterReq).promise()

      if (subFilterResp.subscriptionFilters.length === 0) {
        console.log(`[${logGroupName}] doesn't have a filter yet`)

        // swallow exception so we can move onto the next log group
        await subscribe(logGroupName).catch(_ => {})
      } else if (subFilterResp.subscriptionFilters[0].destinationArn !== DESTINATION_ARN) {
        const oldDestArn = subFilterResp.subscriptionFilters[0].destinationArn
        console.log(`[${logGroupName}] has an old destination ARN [${oldDestArn}], updating...`)

        // swallow exception so we can move onto the next log group
        await subscribe(logGroupName).catch(console.error)
      }
    }

    if (resp.nextToken) {
      await loop(resp.nextToken)
    }
  }

  await loop()
}

module.exports.newLogGroups = async (event) => {
  console.log(JSON.stringify(event))

  // eg. /aws/lambda/logging-demo-dev-api
  const logGroupName = event.detail.requestParameters.logGroupName
  console.log(`log group: ${logGroupName}`)

  if (EXCLUDE_PREFIX && logGroupName.startsWith(EXCLUDE_PREFIX)) {
    console.log(`ignored the log group [${logGroupName}] because it matches the exclude prefix [${EXCLUDE_PREFIX}]`)
    return
  }

  if (PREFIX && !logGroupName.startsWith(PREFIX)) {
    console.log(`ignored the log group [${logGroupName}] because it doesn't match the prefix [${PREFIX}]`)
    return
  }

  await subscribe(logGroupName)
}

const subscribe = async (logGroupName) => {
  try {
    await putSubscriptionFilter(logGroupName)
  } catch (err) {
    console.log(err)

    // when subscribing a log group to a Lambda function, CloudWatch Logs needs permission
    // to invoke the function
    if (err.code === 'InvalidParameterException' &&
        err.message === 'Could not execute the lambda function. Make sure you have given CloudWatch Logs permission to execute your function.') {
      console.log(`adding lambda:InvokeFunction permission to CloudWatch Logs for [${DESTINATION_ARN}]`)
      await addLambdaPermission(DESTINATION_ARN)

      // retry!
      await putSubscriptionFilter(logGroupName)
    } else {
      throw err
    }
  }
}

const putSubscriptionFilter = async (logGroupName) => {
  // when subscribing a stream to Kinesis/Firehose, you need to specify the roleArn
  const roleArn = !isLambda ? ROLE_ARN : undefined

  const req = {
    destinationArn: DESTINATION_ARN,
    logGroupName: logGroupName,
    filterName: filterName,
    filterPattern: filterPattern,
    roleArn: roleArn
  }

  console.log(JSON.stringify(req))

  await cloudWatchLogs.putSubscriptionFilter(req).promise()

  console.log(`subscribed [${logGroupName}] to [${DESTINATION_ARN}]`)
}

const addLambdaPermission = async (functionArn) => {
  const req = {
    Action: 'lambda:InvokeFunction',
    FunctionName: functionArn,
    Principal: 'logs.amazonaws.com',
    StatementId: `invoke-${uuid().substring(0, 8)}`
  }
  await lambda.addPermission(req).promise()
}
