import {
	Uniform
} from '../../../src/Three';

export const GTAOShader: {
	defines: {
		STEP_PRECISION: number;
		MULTI_BOUNCE: number;
		COSINE_WEIGHTING: number;
		NORMAL_TEXTURE: number;
		DEPTH_PACKING: number;
		BEGIN_DEPTH_FADE: number;
		END_DEPTH_FADE: number;
		MAX_TRACE_LENGTH: number;
	};
	uniforms: {
		tDepth: Uniform;
		tDiffuse: Uniform;
		tNormal: Uniform;
		samples: Uniform;
		size: Uniform;
		cameraNear: Uniform;
		cameraFar: Uniform;
		cameraProjectionMatrix: Uniform;
		cameraInverseProjectionMatrix: Uniform;
		intensity: Uniform;
		distance: Uniform;
		frameCount: Uniform;
		multiBounce: Uniform;
	};
	vertexShader: string;
	fragmentShader: string;
};
