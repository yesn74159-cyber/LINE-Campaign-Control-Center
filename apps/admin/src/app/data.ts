import campaignsManifest from '../../../../campaigns.json';
import welcomeFlex from '../../../../flex/welcome.json';
import activityFlex from '../../../../flex/activity.json';
import newsFlex from '../../../../flex/news.json';
import flashFlex from '../../../../flex/flash.json';
import gradientFlex from '../../../../flex/gradient.json';
import purpleFlex from '../../../../flex/purple.json';
import profileFlex from '../../../../flex/profile.json';
import type { Campaign } from './types.js';

export const campaignSeed = campaignsManifest.campaigns as Campaign[];
export const flexById: Record<string, object> = { welcome: welcomeFlex, activity: activityFlex, news: newsFlex, flash: flashFlex, gradient: gradientFlex, purple: purpleFlex, profile: profileFlex };
export const imageById: Record<string, string> = {
  welcome: new URL('../../../../assets/coupon.png', import.meta.url).href,
  activity: new URL('../../../../assets/activity.png', import.meta.url).href,
  news: new URL('../../../../assets/news.png', import.meta.url).href,
  flash: new URL('../../../../assets/coupon.png', import.meta.url).href,
  gradient: new URL('../../../../assets/activity.png', import.meta.url).href,
  purple: new URL('../../../../assets/news.png', import.meta.url).href,
  profile: new URL('../../../../assets/news.png', import.meta.url).href
};
