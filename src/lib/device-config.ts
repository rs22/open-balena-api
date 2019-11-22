import * as _ from 'lodash';

import * as Promise from 'bluebird';
import * as fs from 'fs';

import * as deviceConfig from 'resin-device-config';
import * as resinSemver from 'resin-semver';

import { DeviceType } from './device-types';

import { captureException } from '../platform/errors';
import { getUser } from '../platform/auth';
import { sbvrUtils } from '@resin/pinejs';
import { createUserApiKey, createProvisioningApiKey } from './api-keys';
import { Request } from 'express';
import { Option as DeviceTypeOption } from '@resin.io/device-types';

const { BadRequestError } = sbvrUtils;

// FIXME(refactor): many of the following are resin-specific
import {
	REGISTRY2_HOST,
	NODE_EXTRA_CA_CERTS,
	MIXPANEL_TOKEN,
	VPN_HOST,
	VPN_PORT,
	API_HOST,
	DELTA_HOST,
} from './config';

export const generateConfig = (
	req: Request,
	app: AnyObject,
	deviceType: DeviceType,
	osVersion: string,
) => {
	const userPromise = getUser(req);

	// Devices running ResinOS >=1.2.1 are capable of using Registry v2, while earlier ones must use v1
	if (resinSemver.lte(osVersion, '1.2.0')) {
		throw new BadRequestError(
			'balenaOS versions <= 1.2.0 are no longer supported, please update',
		);
	}
	const registryHost = REGISTRY2_HOST;

	const apiKeyPromise = Promise.try(() => {
		// Devices running ResinOS >= 2.7.8 can use provisioning keys
		if (resinSemver.satisfies(osVersion, '<2.7.8')) {
			// Older ones have to use the old "user api keys"
			return userPromise.then(user => createUserApiKey(req, user.id));
		}
		return createProvisioningApiKey(req, app.id);
	});

	// There may be multiple CAs, this doesn't matter as all will be passed in the config
	const selfSignedRootPromise = Promise.try(() => {
		const caFile = NODE_EXTRA_CA_CERTS;
		if (!caFile) {
			return;
		}
		return fs.promises
			.stat(caFile)
			.then(() => fs.promises.readFile(caFile, 'utf8'))
			.then(pem => Buffer.from(pem).toString('base64'))
			.catch(err => {
				if (err.code === 'ENOENT') {
					return;
				}
				captureException(err, 'Self-signed root CA could not be read');
			});
	});

	return Promise.join(
		userPromise,
		apiKeyPromise,
		selfSignedRootPromise,
		(user, apiKey, rootCA) => {
			const config = deviceConfig.generate(
				{
					application: app as deviceConfig.GenerateOptions['application'],
					deviceType: deviceType.slug,
					user,
					apiKey,
					pubnub: {},
					mixpanel: {
						token: MIXPANEL_TOKEN,
					},
					vpnPort: VPN_PORT,
					endpoints: {
						api: `https://${API_HOST}`,
						delta: `https://${DELTA_HOST}`,
						registry: registryHost,
						vpn: VPN_HOST,
					},
					version: osVersion,
				},
				{
					appUpdatePollInterval:
						_.parseInt(req.param('appUpdatePollInterval')) * 60 * 1000,
					network: req.param('network'),
					wifiSsid: req.param('wifiSsid'),
					wifiKey: req.param('wifiKey'),
					ip: req.param('ip'),
					gateway: req.param('gateway'),
					netmask: req.param('netmask'),
				},
			);

			_(deviceType.options!)
				.flatMap((opt): DeviceTypeOption[] | DeviceTypeOption => {
					if (opt.isGroup && ['network', 'advanced'].includes(opt.name)) {
						// already handled above
						return [];
					} else if (opt.isGroup) {
						return opt.options;
					} else {
						return opt;
					}
				})
				.each(({ name: optionName }) => {
					config[optionName] = req.param(optionName);
				});
			if (rootCA != null) {
				config.balenaRootCA = rootCA;
			}
			return config;
		},
	);
};
