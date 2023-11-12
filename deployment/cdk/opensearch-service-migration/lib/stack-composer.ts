import {Construct} from "constructs";
import {RemovalPolicy, Stack, StackProps} from "aws-cdk-lib";
import {OpenSearchDomainStack} from "./opensearch-domain-stack";
import {EngineVersion, TLSSecurityPolicy} from "aws-cdk-lib/aws-opensearchservice";
import {EbsDeviceVolumeType} from "aws-cdk-lib/aws-ec2";
import {AnyPrincipal, Effect, PolicyStatement} from "aws-cdk-lib/aws-iam";
import * as defaultValuesJson from "../default-values.json"
import {NetworkStack} from "./network-stack";
import {MigrationAssistanceStack} from "./migration-assistance-stack";
import {FetchMigrationStack} from "./fetch-migration-stack";
import {MSKUtilityStack} from "./msk-utility-stack";
import {MigrationAnalyticsStack} from "./service-stacks/migration-analytics-stack";
import {MigrationConsoleStack} from "./service-stacks/migration-console-stack";
import {CaptureProxyESStack} from "./service-stacks/capture-proxy-es-stack";
import {TrafficReplayerStack} from "./service-stacks/traffic-replayer-stack";
import {CaptureProxyStack} from "./service-stacks/capture-proxy-stack";
import {ElasticsearchStack} from "./service-stacks/elasticsearch-stack";
import {KafkaBrokerStack} from "./service-stacks/kafka-broker-stack";
import {KafkaZookeeperStack} from "./service-stacks/kafka-zookeeper-stack";
import {Application} from "@aws-cdk/aws-servicecatalogappregistry-alpha";

export interface StackPropsExt extends StackProps {
    readonly stage: string,
    readonly defaultDeployId: string
    readonly addOnMigrationDeployId?: string
}

export interface StackComposerProps extends StackProps {
    readonly migrationsAppRegistryARN?: string
}

export class StackComposer {
    public stacks: Stack[] = [];

    private addStacksToAppRegistry(scope: Construct, appRegistryAppARN: string, allStacks: Stack[]) {
        for (let stack of allStacks) {
            const appRegistryApp = Application.fromApplicationArn(stack, 'AppRegistryApplicationImport', appRegistryAppARN)
            appRegistryApp.associateApplicationWithStack(stack)
        }
    }

    private getContextForType(optionName: string, expectedType: string, defaultValues: { [x: string]: (any); }, contextJSON: { [x: string]: (any); }): any {
        const option = contextJSON[optionName]

        // If no context is provided (undefined or empty string) and a default value exists, use it
        if ((option === undefined || option === "") && defaultValues[optionName]) {
            return defaultValues[optionName]
        }

        // Filter out invalid or missing options by setting undefined (empty strings, null, undefined, NaN)
        if (option !== false && option !== 0 && !option) {
            return undefined
        }
        // Values provided by the CLI will always be represented as a string and need to be parsed
        if (typeof option === 'string') {
            if (expectedType === 'number') {
                return parseInt(option)
            }
            if (expectedType === 'boolean' || expectedType === 'object') {
                return JSON.parse(option)
            }
        }
        // Values provided by the cdk.context.json should be of the desired type
        if (typeof option !== expectedType) {
            throw new Error(`Type provided by cdk.context.json for ${optionName} was ${typeof option} but expected ${expectedType}`)
        }
        return option
    }

    private parseAccessPolicies(jsonObject: { [x: string]: any; }): PolicyStatement[] {
        let accessPolicies: PolicyStatement[] = []
        const statements = jsonObject['Statement']
        if (!statements || statements.length < 1) {
            throw new Error ("Provided accessPolicies JSON must have the 'Statement' element present and not be empty, for reference https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_elements_statement.html")
        }
        // Access policies can provide a single Statement block or an array of Statement blocks
        if (Array.isArray(statements)) {
            for (let statementBlock of statements) {
                const statement = PolicyStatement.fromJson(statementBlock)
                accessPolicies.push(statement)
            }
        }
        else {
            const statement = PolicyStatement.fromJson(statements)
            accessPolicies.push(statement)
        }
        return accessPolicies
    }


    private getEngineVersion(engineVersionString: string) : EngineVersion {
        let version: EngineVersion
        if (engineVersionString && engineVersionString.startsWith("OS_")) {
            // Will accept a period delimited version string (i.e. 1.3) and return a proper EngineVersion
            version = EngineVersion.openSearch(engineVersionString.substring(3))
        } else if (engineVersionString && engineVersionString.startsWith("ES_")) {
            version = EngineVersion.elasticsearch(engineVersionString.substring(3))
        } else {
            throw new Error("Engine version is not present or does not match the expected format, i.e. OS_1.3 or ES_7.9")
        }
        return version
    }

    constructor(scope: Construct, props: StackComposerProps) {

        const defaultValues: { [x: string]: (any); } = defaultValuesJson
        const account = props.env?.account
        const region = props.env?.region
        const defaultDeployId = 'default'

        const contextId = scope.node.tryGetContext("contextId")
        if (!contextId) {
            throw new Error("Required context field 'contextId' not provided")
        }
        const contextJSON = scope.node.tryGetContext(contextId)
        if (!contextJSON) {
            throw new Error(`No CDK context block found for contextId '${contextId}'`)
        }
        const stage = this.getContextForType('stage', 'string', defaultValues, contextJSON)

        let version: EngineVersion
        let accessPolicies: PolicyStatement[]|undefined

        const domainName = this.getContextForType('domainName', 'string', defaultValues, contextJSON)
        const dataNodeType = this.getContextForType('dataNodeType', 'string', defaultValues, contextJSON)
        const dataNodeCount = this.getContextForType('dataNodeCount', 'number', defaultValues, contextJSON)
        const dedicatedManagerNodeType = this.getContextForType('dedicatedManagerNodeType', 'string', defaultValues, contextJSON)
        const dedicatedManagerNodeCount = this.getContextForType('dedicatedManagerNodeCount', 'number', defaultValues, contextJSON)
        const warmNodeType = this.getContextForType('warmNodeType', 'string', defaultValues, contextJSON)
        const warmNodeCount = this.getContextForType('warmNodeCount', 'number', defaultValues, contextJSON)
        const useUnsignedBasicAuth = this.getContextForType('useUnsignedBasicAuth', 'boolean', defaultValues, contextJSON)
        const fineGrainedManagerUserARN = this.getContextForType('fineGrainedManagerUserARN', 'string', defaultValues, contextJSON)
        const fineGrainedManagerUserName = this.getContextForType('fineGrainedManagerUserName', 'string', defaultValues, contextJSON)
        const fineGrainedManagerUserSecretManagerKeyARN = this.getContextForType('fineGrainedManagerUserSecretManagerKeyARN', 'string', defaultValues, contextJSON)
        const enableDemoAdmin = this.getContextForType('enableDemoAdmin', 'boolean', defaultValues, contextJSON)
        const enforceHTTPS = this.getContextForType('enforceHTTPS', 'boolean', defaultValues, contextJSON)
        const ebsEnabled = this.getContextForType('ebsEnabled', 'boolean', defaultValues, contextJSON)
        const ebsIops = this.getContextForType('ebsIops', 'number', defaultValues, contextJSON)
        const ebsVolumeSize = this.getContextForType('ebsVolumeSize', 'number', defaultValues, contextJSON)
        const encryptionAtRestEnabled = this.getContextForType('encryptionAtRestEnabled', 'boolean', defaultValues, contextJSON)
        const encryptionAtRestKmsKeyARN = this.getContextForType("encryptionAtRestKmsKeyARN", 'string', defaultValues, contextJSON)
        const loggingAppLogEnabled = this.getContextForType('loggingAppLogEnabled', 'boolean', defaultValues, contextJSON)
        const loggingAppLogGroupARN = this.getContextForType('loggingAppLogGroupARN', 'string', defaultValues, contextJSON)
        const noneToNodeEncryptionEnabled = this.getContextForType('nodeToNodeEncryptionEnabled', 'boolean', defaultValues, contextJSON)
        const vpcId = this.getContextForType('vpcId', 'string', defaultValues, contextJSON)
        const vpcEnabled = this.getContextForType('vpcEnabled', 'boolean', defaultValues, contextJSON)
        const vpcSecurityGroupIds = this.getContextForType('vpcSecurityGroupIds', 'object', defaultValues, contextJSON)
        const vpcSubnetIds = this.getContextForType('vpcSubnetIds', 'object', defaultValues, contextJSON)
        const openAccessPolicyEnabled = this.getContextForType('openAccessPolicyEnabled', 'boolean', defaultValues, contextJSON)
        const availabilityZoneCount = this.getContextForType('availabilityZoneCount', 'number', defaultValues, contextJSON)
        const migrationAssistanceEnabled = this.getContextForType('migrationAssistanceEnabled', 'boolean', defaultValues, contextJSON)
        const mskARN = this.getContextForType('mskARN', 'string', defaultValues, contextJSON)
        const mskEnablePublicEndpoints = this.getContextForType('mskEnablePublicEndpoints', 'boolean', defaultValues, contextJSON)
        const mskRestrictPublicAccessTo = this.getContextForType('mskRestrictPublicAccessTo', 'string', defaultValues, contextJSON)
        const mskRestrictPublicAccessType = this.getContextForType('mskRestrictPublicAccessType', 'string', defaultValues, contextJSON)
        const mskBrokerNodeCount = this.getContextForType('mskBrokerNodeCount', 'number', defaultValues, contextJSON)
        const addOnMigrationDeployId = this.getContextForType('addOnMigrationDeployId', 'string', defaultValues, contextJSON)
        const captureProxyESServiceEnabled = this.getContextForType('captureProxyESServiceEnabled', 'boolean', defaultValues, contextJSON)
        const migrationConsoleServiceEnabled = this.getContextForType('migrationConsoleServiceEnabled', 'boolean', defaultValues, contextJSON)
        const trafficReplayerServiceEnabled = this.getContextForType('trafficReplayerServiceEnabled', 'boolean', defaultValues, contextJSON)
        const trafficReplayerEnableClusterFGACAuth = this.getContextForType('trafficReplayerEnableClusterFGACAuth', 'boolean', defaultValues, contextJSON)
        const trafficReplayerTargetEndpoint = this.getContextForType('trafficReplayerTargetEndpoint', 'string', defaultValues, contextJSON)
        const trafficReplayerGroupId = this.getContextForType('trafficReplayerGroupId', 'string', defaultValues, contextJSON)
        const trafficReplayerExtraArgs = this.getContextForType('trafficReplayerExtraArgs', 'string', defaultValues, contextJSON)
        const captureProxyServiceEnabled = this.getContextForType('captureProxyServiceEnabled', 'boolean', defaultValues, contextJSON)
        const captureProxySourceEndpoint = this.getContextForType('captureProxySourceEndpoint', 'string', defaultValues, contextJSON)
        const elasticsearchServiceEnabled = this.getContextForType('elasticsearchServiceEnabled', 'boolean', defaultValues, contextJSON)
        const kafkaBrokerServiceEnabled = this.getContextForType('kafkaBrokerServiceEnabled', 'boolean', defaultValues, contextJSON)
        const kafkaZookeeperServiceEnabled = this.getContextForType('kafkaZookeeperServiceEnabled', 'boolean', defaultValues, contextJSON)
        const fetchMigrationEnabled = this.getContextForType('fetchMigrationEnabled', 'boolean', defaultValues, contextJSON)
        const dpPipelineTemplatePath = this.getContextForType('dpPipelineTemplatePath', 'string', defaultValues, contextJSON)
        const sourceClusterEndpoint = this.getContextForType('sourceClusterEndpoint', 'string', defaultValues, contextJSON)

        const migrationAnalyticsServiceEnabled = this.getContextForType('migrationAnalyticsServiceEnabled', 'boolean', defaultValues, contextJSON)
        const otelConfigFilePath = this.getContextForType('otelConfigFilePath', 'string', defaultValues, contextJSON)

        const analyticsDomainEngineVersion = this.getContextForType('analyticsDomainEngineVersion', 'string', defaultValues, contextJSON)
        const analyticsDomainDataNodeType = this.getContextForType('analyticsDomainDataNodeType', 'string', defaultValues, contextJSON)
        const analyticsDomainDataNodeCount = this.getContextForType('analyticsDomainDataNodeCount', 'number', defaultValues, contextJSON)
        const analyticsDomainDedicatedManagerNodeType = this.getContextForType('analyticsDomainDedicatedManagerNodeType', 'string', defaultValues, contextJSON)
        const analyticsDomainDedicatedManagerNodeCount = this.getContextForType('analyticsDomainDedicatedManagerNodeCount', 'number', defaultValues, contextJSON)
        const analyticsDomainWarmNodeType = this.getContextForType('analyticsDomainWarmNodeType', 'string', defaultValues, contextJSON)
        const analyticsDomainWarmNodeCount = this.getContextForType('analyticsDomainWarmNodeCount', 'number', defaultValues, contextJSON)
        // const analyticsDomainUseUnsignedBasicAuth = this.getContextForType('analyticsDomainUseUnsignedBasicAuth', 'boolean')
        // const analyticsDomainFineGrainedManagerUserARN = this.getContextForType('analyticsDomainFineGrainedManagerUserARN', 'string')
        // const analyticsDomainFineGrainedManagerUserName = this.getContextForType('analyticsDomainFineGrainedManagerUserName', 'string')
        // const analyticsDomainFineGrainedManagerUserSecretManagerKeyARN = this.getContextForType('analyticsDomainFineGrainedManagerUserSecretManagerKeyARN', 'string')
        const analyticsDomainEnforceHTTPS = this.getContextForType('analyticsDomainEnforceHTTPS', 'boolean', defaultValues, contextJSON)
        const analyticsDomainEbsEnabled = this.getContextForType('analyticsDomainEbsEnabled', 'boolean', defaultValues, contextJSON)
        const analyticsDomainEbsIops = this.getContextForType('analyticsDomainEbsIops', 'number', defaultValues, contextJSON)
        const analyticsDomainEbsVolumeSize = this.getContextForType('analyticsDomainEbsVolumeSize', 'number', defaultValues, contextJSON)
        const analyticsDomainEncryptionAtRestEnabled = this.getContextForType('analyticsDomainEncryptionAtRestEnabled', 'boolean', defaultValues, contextJSON)
        const analyticsDomainEncryptionAtRestKmsKeyARN = this.getContextForType("analyticsDomainEncryptionAtRestKmsKeyARN", 'string', defaultValues, contextJSON)
        const analyticsDomainLoggingAppLogEnabled = this.getContextForType('analyticsDomainLoggingAppLogEnabled', 'boolean', defaultValues, contextJSON)
        const analyticsDomainLoggingAppLogGroupARN = this.getContextForType('analyticsDomainLoggingAppLogGroupARN', 'string', defaultValues, contextJSON)
        const analyticsDomainNoneToNodeEncryptionEnabled = this.getContextForType('analyticsDomainNodeToNodeEncryptionEnabled', 'boolean', defaultValues, contextJSON)

        if (!stage) {
            throw new Error("Required context field 'stage' is not present")
        }
        if (addOnMigrationDeployId && vpcId) {
            console.warn("Addon deployments will use the original deployment 'vpcId' regardless of passed 'vpcId' values")
        }
        if (!domainName) {
            throw new Error("Domain name is not present and is a required field")
        }

        const engineVersion = this.getContextForType('engineVersion', 'string', defaultValues, contextJSON)
        version = this.getEngineVersion(engineVersion)

        if (openAccessPolicyEnabled) {
            const openPolicy = new PolicyStatement({
                effect: Effect.ALLOW,
                principals: [new AnyPrincipal()],
                actions: ["es:*"],
                resources: [`arn:aws:es:${region}:${account}:domain/${domainName}/*`]
            })
            accessPolicies = [openPolicy]
        } else {
            const accessPolicyJson = this.getContextForType('accessPolicies', 'object', defaultValues, contextJSON)
            accessPolicies = accessPolicyJson ? this.parseAccessPolicies(accessPolicyJson) : undefined
        }

        const tlsSecurityPolicyName = this.getContextForType('tlsSecurityPolicy', 'string', defaultValues, contextJSON)
        const tlsSecurityPolicy: TLSSecurityPolicy|undefined = tlsSecurityPolicyName ? TLSSecurityPolicy[tlsSecurityPolicyName as keyof typeof TLSSecurityPolicy] : undefined
        if (tlsSecurityPolicyName && !tlsSecurityPolicy) {
            throw new Error("Provided tlsSecurityPolicy does not match a selectable option, for reference https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_opensearchservice.TLSSecurityPolicy.html")
        }

        const ebsVolumeTypeName = this.getContextForType('ebsVolumeType', 'string', defaultValues, contextJSON)
        const ebsVolumeType: EbsDeviceVolumeType|undefined = ebsVolumeTypeName ? EbsDeviceVolumeType[ebsVolumeTypeName as keyof typeof EbsDeviceVolumeType] : undefined
        if (ebsVolumeTypeName && !ebsVolumeType) {
            throw new Error("Provided ebsVolumeType does not match a selectable option, for reference https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_ec2.EbsDeviceVolumeType.html")
        }

        const analyticsDomainEbsVolumeTypeName = this.getContextForType('analyticsDomainEbsVolumeType', 'string', defaultValues, contextJSON)
        const analyticsDomainEbsVolumeType: EbsDeviceVolumeType|undefined = analyticsDomainEbsVolumeTypeName ? EbsDeviceVolumeType[analyticsDomainEbsVolumeTypeName as keyof typeof EbsDeviceVolumeType] : undefined
        if (analyticsDomainEbsVolumeTypeName && !analyticsDomainEbsVolumeType) {
            throw new Error("Provided ebsVolumeType does not match a selectable option, for reference https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_ec2.EbsDeviceVolumeType.html")
        }

        const domainRemovalPolicyName = this.getContextForType('domainRemovalPolicy', 'string', defaultValues, contextJSON)
        const domainRemovalPolicy = domainRemovalPolicyName ? RemovalPolicy[domainRemovalPolicyName as keyof typeof RemovalPolicy] : undefined
        if (domainRemovalPolicyName && !domainRemovalPolicy) {
            throw new Error("Provided domainRemovalPolicy does not match a selectable option, for reference https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.RemovalPolicy.html")
        }

        const deployId = addOnMigrationDeployId ? addOnMigrationDeployId : defaultDeployId

        // If enabled re-use existing VPC and/or associated resources or create new
        let networkStack: NetworkStack|undefined
        if (vpcEnabled || addOnMigrationDeployId) {
            networkStack = new NetworkStack(scope, `networkStack-${deployId}`, {
                vpcId: vpcId,
                availabilityZoneCount: availabilityZoneCount,
                stackName: `OSMigrations-${stage}-${region}-${deployId}-NetworkInfra`,
                description: "This stack contains resources to create/manage networking for an OpenSearch Service domain",
                stage: stage,
                defaultDeployId: defaultDeployId,
                addOnMigrationDeployId: addOnMigrationDeployId,
                migrationAnalyticsEnabled: migrationAnalyticsServiceEnabled,
                ...props,
            })
            this.stacks.push(networkStack)
        }

        const openSearchStack = new OpenSearchDomainStack(scope, `openSearchDomainStack-${deployId}`, {
            version: version,
            domainName: domainName,
            dataNodeInstanceType: dataNodeType,
            dataNodes: dataNodeCount,
            dedicatedManagerNodeType: dedicatedManagerNodeType,
            dedicatedManagerNodeCount: dedicatedManagerNodeCount,
            warmInstanceType: warmNodeType,
            warmNodes: warmNodeCount,
            accessPolicies: accessPolicies,
            useUnsignedBasicAuth: useUnsignedBasicAuth,
            fineGrainedManagerUserARN: fineGrainedManagerUserARN,
            fineGrainedManagerUserName: fineGrainedManagerUserName,
            fineGrainedManagerUserSecretManagerKeyARN: fineGrainedManagerUserSecretManagerKeyARN,
            enableDemoAdmin: enableDemoAdmin,
            enforceHTTPS: enforceHTTPS,
            tlsSecurityPolicy: tlsSecurityPolicy,
            ebsEnabled: ebsEnabled,
            ebsIops: ebsIops,
            ebsVolumeSize: ebsVolumeSize,
            ebsVolumeType: ebsVolumeType,
            encryptionAtRestEnabled: encryptionAtRestEnabled,
            encryptionAtRestKmsKeyARN: encryptionAtRestKmsKeyARN,
            appLogEnabled: loggingAppLogEnabled,
            appLogGroup: loggingAppLogGroupARN,
            nodeToNodeEncryptionEnabled: noneToNodeEncryptionEnabled,
            vpc: networkStack ? networkStack.vpc : undefined,
            vpcSubnetIds: vpcSubnetIds,
            vpcSecurityGroupIds: vpcSecurityGroupIds,
            availabilityZoneCount: availabilityZoneCount,
            domainRemovalPolicy: domainRemovalPolicy,
            stackName: `OSMigrations-${stage}-${region}-${deployId}-OpenSearchDomain`,
            description: "This stack contains resources to create/manage an OpenSearch Service domain",
            stage: stage,
            defaultDeployId: defaultDeployId,
            addOnMigrationDeployId: addOnMigrationDeployId,
            ...props,
        });

        if (networkStack) {
            openSearchStack.addDependency(networkStack)
        }
        this.stacks.push(openSearchStack)

        // Currently, placing a requirement on a VPC for a migration stack but this can be revisited
        let migrationStack
        let mskUtilityStack
        if (migrationAssistanceEnabled && networkStack && !addOnMigrationDeployId) {
            migrationStack = new MigrationAssistanceStack(scope, "migrationInfraStack", {
                vpc: networkStack.vpc,
                mskImportARN: mskARN,
                mskEnablePublicEndpoints: mskEnablePublicEndpoints,
                mskRestrictPublicAccessTo: mskRestrictPublicAccessTo,
                mskRestrictPublicAccessType: mskRestrictPublicAccessType,
                mskBrokerNodeCount: mskBrokerNodeCount,
                stackName: `OSMigrations-${stage}-${region}-MigrationInfra`,
                description: "This stack contains resources to assist migrating an OpenSearch Service domain",
                stage: stage,
                defaultDeployId: defaultDeployId,
                ...props,
            })
            migrationStack.addDependency(networkStack)
            this.stacks.push(migrationStack)

            mskUtilityStack = new MSKUtilityStack(scope, 'mskUtilityStack', {
                vpc: networkStack.vpc,
                mskEnablePublicEndpoints: mskEnablePublicEndpoints,
                stackName: `OSMigrations-${stage}-${region}-MSKUtility`,
                description: "This stack contains custom resources to add additional functionality to the MSK L1 construct",
                stage: stage,
                defaultDeployId: defaultDeployId,
                ...props,
            })
            mskUtilityStack.addDependency(migrationStack)
            this.stacks.push(mskUtilityStack)
        }

        let migrationAnalyticsStack
        if (migrationAnalyticsServiceEnabled && networkStack) {
            migrationAnalyticsStack = new MigrationAnalyticsStack(scope, "migration-analytics", {
                vpc: networkStack.vpc,
                vpcSubnetIds: vpcSubnetIds,
                vpcSecurityGroupIds: vpcSecurityGroupIds,
                availabilityZoneCount: availabilityZoneCount,
                stackName: `OSMigrations-${stage}-${region}-MigrationAnalytics`,
                description: "This stack contains resources for the Open Telemetry Collector and Analytics OS Cluster",
                engineVersion: this.getEngineVersion(analyticsDomainEngineVersion ?? engineVersion), // if no analytics version is specified, use the same as the target cluster
                dataNodeInstanceType: analyticsDomainDataNodeType,
                dataNodes: analyticsDomainDataNodeCount ?? availabilityZoneCount,
                dedicatedManagerNodeType: analyticsDomainDedicatedManagerNodeType,
                dedicatedManagerNodeCount: analyticsDomainDedicatedManagerNodeCount,
                warmInstanceType: analyticsDomainWarmNodeType,
                warmNodes: analyticsDomainWarmNodeCount,
                enforceHTTPS: analyticsDomainEnforceHTTPS,
                ebsEnabled: analyticsDomainEbsEnabled,
                ebsIops: analyticsDomainEbsIops,
                ebsVolumeSize: analyticsDomainEbsVolumeSize,
                ebsVolumeType: analyticsDomainEbsVolumeType,
                encryptionAtRestEnabled: analyticsDomainEncryptionAtRestEnabled,
                encryptionAtRestKmsKeyARN: analyticsDomainEncryptionAtRestKmsKeyARN,
                appLogEnabled: analyticsDomainLoggingAppLogEnabled,
                appLogGroup: analyticsDomainLoggingAppLogGroupARN,
                nodeToNodeEncryptionEnabled: analyticsDomainNoneToNodeEncryptionEnabled,
                stage: stage,
                defaultDeployId: defaultDeployId,
                ...props,
            })
            // To enable the Migration Console to make requests to other service endpoints with Service Connect,
            // it must be deployed after these services
            // if (captureProxyESStack) {
            //     migrationAnalyticsStack.addDependency(captureProxyESStack)
            // }
            // if (captureProxyStack) {
            //     migrationAnalyticsStack.addDependency(captureProxyStack)
            // }
            // if (elasticsearchStack) {
            //     migrationAnalyticsStack.addDependency(elasticsearchStack)
            // }
            if (networkStack) {
                migrationAnalyticsStack.openSearchAnalyticsStack.addDependency(networkStack)
            }
            this.stacks.push(migrationAnalyticsStack.openSearchAnalyticsStack)
            migrationAnalyticsStack.addDependency(migrationAnalyticsStack.openSearchAnalyticsStack)
            this.stacks.push(migrationAnalyticsStack)
        }

        // Currently, placing a requirement on a VPC for a fetch migration stack but this can be revisited
        // TODO: Future work to provide orchestration between fetch migration and migration assistance
        let fetchMigrationStack
        if (fetchMigrationEnabled && networkStack && openSearchStack && migrationStack) {
            fetchMigrationStack = new FetchMigrationStack(scope, "fetchMigrationStack", {
                vpc: networkStack.vpc,
                dpPipelineTemplatePath: dpPipelineTemplatePath,
                sourceEndpoint: sourceClusterEndpoint,
                stackName: `OSMigrations-${stage}-${region}-FetchMigration`,
                description: "This stack contains resources to assist migrating historical data to an OpenSearch Service domain",
                stage: stage,
                defaultDeployId: defaultDeployId,
                ...props,
            })
            fetchMigrationStack.addDependency(openSearchStack)
            fetchMigrationStack.addDependency(migrationStack)
            this.stacks.push(fetchMigrationStack)
        }

        let captureProxyESStack
        if (captureProxyESServiceEnabled && networkStack && mskUtilityStack) {
            captureProxyESStack = new CaptureProxyESStack(scope, "capture-proxy-es", {
                vpc: networkStack.vpc,
                stackName: `OSMigrations-${stage}-${region}-CaptureProxyES`,
                description: "This stack contains resources for the Capture Proxy/Elasticsearch ECS service",
                stage: stage,
                defaultDeployId: defaultDeployId,
                ...props,
            })
            captureProxyESStack.addDependency(mskUtilityStack)
            this.stacks.push(captureProxyESStack)
        }

        let trafficReplayerStack
        if ((trafficReplayerServiceEnabled && networkStack && openSearchStack && migrationStack && mskUtilityStack) || (addOnMigrationDeployId && networkStack)) {
            trafficReplayerStack = new TrafficReplayerStack(scope, `traffic-replayer-${deployId}`, {
                vpc: networkStack.vpc,
                enableClusterFGACAuth: trafficReplayerEnableClusterFGACAuth,
                addOnMigrationDeployId: addOnMigrationDeployId,
                customTargetEndpoint: trafficReplayerTargetEndpoint,
                customKafkaGroupId: trafficReplayerGroupId,
                extraArgs: trafficReplayerExtraArgs,
                stackName: `OSMigrations-${stage}-${region}-${deployId}-TrafficReplayer`,
                description: "This stack contains resources for the Traffic Replayer ECS service",
                stage: stage,
                defaultDeployId: defaultDeployId,
                ...props,
            })
            if (mskUtilityStack) {
                trafficReplayerStack.addDependency(mskUtilityStack)
            }
            if (migrationStack) {
                trafficReplayerStack.addDependency(migrationStack)
            }
            trafficReplayerStack.addDependency(openSearchStack)
            trafficReplayerStack.addDependency(networkStack)
            this.stacks.push(trafficReplayerStack)
        }

        let elasticsearchStack
        if (elasticsearchServiceEnabled && networkStack && migrationStack) {
            elasticsearchStack = new ElasticsearchStack(scope, "elasticsearch", {
                vpc: networkStack.vpc,
                stackName: `OSMigrations-${stage}-${region}-Elasticsearch`,
                description: "This stack contains resources for a testing mock Elasticsearch single node cluster ECS service",
                stage: stage,
                defaultDeployId: defaultDeployId,
                ...props,
            })
            elasticsearchStack.addDependency(migrationStack)
            this.stacks.push(elasticsearchStack)
        }

        let captureProxyStack
        if (captureProxyServiceEnabled && networkStack && mskUtilityStack) {
            captureProxyStack = new CaptureProxyStack(scope, "capture-proxy", {
                vpc: networkStack.vpc,
                customSourceClusterEndpoint: captureProxySourceEndpoint,
                stackName: `OSMigrations-${stage}-${region}-CaptureProxy`,
                description: "This stack contains resources for the Capture Proxy ECS service",
                stage: stage,
                defaultDeployId: defaultDeployId,
                ...props,
            })
            if (elasticsearchStack) {
                captureProxyStack.addDependency(elasticsearchStack)
            }
            captureProxyStack.addDependency(mskUtilityStack)
            this.stacks.push(captureProxyStack)
        }

        let kafkaBrokerStack
        if (kafkaBrokerServiceEnabled && networkStack && migrationStack) {
            kafkaBrokerStack = new KafkaBrokerStack(scope, "kafka-broker", {
                vpc: networkStack.vpc,
                stackName: `OSMigrations-${stage}-${region}-KafkaBroker`,
                description: "This stack contains resources for the Kafka Broker ECS service",
                stage: stage,
                defaultDeployId: defaultDeployId,
                ...props,
            })
            kafkaBrokerStack.addDependency(migrationStack)
            this.stacks.push(kafkaBrokerStack)
        }

        let kafkaZookeeperStack
        if (kafkaZookeeperServiceEnabled && networkStack && migrationStack) {
            kafkaZookeeperStack = new KafkaZookeeperStack(scope, "kafka-zookeeper", {
                vpc: networkStack.vpc,
                stackName: `OSMigrations-${stage}-${region}-KafkaZookeeper`,
                description: "This stack contains resources for the Kafka Zookeeper ECS service",
                stage: stage,
                defaultDeployId: defaultDeployId,
                ...props,
            })
            kafkaZookeeperStack.addDependency(migrationStack)
            this.stacks.push(kafkaZookeeperStack)
        }

        let migrationConsoleStack
        if (migrationConsoleServiceEnabled && networkStack && openSearchStack && mskUtilityStack) {
            migrationConsoleStack = new MigrationConsoleStack(scope, "migration-console", {
                vpc: networkStack.vpc,
                fetchMigrationEnabled: fetchMigrationEnabled,
                stackName: `OSMigrations-${stage}-${region}-MigrationConsole`,
                description: "This stack contains resources for the Migration Console ECS service",
                stage: stage,
                defaultDeployId: defaultDeployId,
                ...props,
            })
            // To enable the Migration Console to make requests to other service endpoints with Service Connect,
            // it must be deployed after these services
            if (captureProxyESStack) {
                migrationConsoleStack.addDependency(captureProxyESStack)
            }
            if (captureProxyStack) {
                migrationConsoleStack.addDependency(captureProxyStack)
            }
            if (elasticsearchStack) {
                migrationConsoleStack.addDependency(elasticsearchStack)
            }
            if (fetchMigrationStack) {
                migrationConsoleStack.addDependency(fetchMigrationStack)
            }
            migrationConsoleStack.addDependency(mskUtilityStack)
            migrationConsoleStack.addDependency(openSearchStack)
            this.stacks.push(migrationConsoleStack)
        }

        if (props.migrationsAppRegistryARN) {
            this.addStacksToAppRegistry(scope, props.migrationsAppRegistryARN, this.stacks)
        }

    }
}