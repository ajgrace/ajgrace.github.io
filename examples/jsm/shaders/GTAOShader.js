// GTAO Shader for ThreeJS (requires WebGL 2.0)
// Author: Alex Grace
//
// Primarily referenced from Practical Realtime Strategies for Accurate Indirect Occlusion
// https://www.activision.com/cdn/research/s2016_pbs_activision_occlusion.pptx
//
// Uses SAOShader.js by ludobaka and bhouston as a base.
//
// Limitations & Further Work:
// As ThreeJS does not support motion vectors, the temporal denoiser will likely exhibit ghosting in motion. 
// The temporal denoiser should therefore be considered a proof of concept rather than a complete solution.
// The GTAO pass should also be combined only in the indirect lighting phase, rather than as a post process. 
//
// Note: Shaders in ThreeJS are represented as strings. Shader examples can often use string arrays
// for each line resulting in an unreadable mess. I chose to use ES6 Template Literals 
// to retain a significant amount of readability and allow for syntax highlighting in my editor.

import {
	Matrix4,
	Vector4
} from "../../../build/three.module.js";

var GTAOShader = {
	defines: {
		"STEP_PRECISION": 3,
		"MULTI_BOUNCE": 1,
		"COSINE_WEIGHTING": 1,
		"NORMAL_TEXTURE": 0,
		"DEPTH_PACKING": 1,
		"BEGIN_DEPTH_FADE": 0.985,
		"END_DEPTH_FADE": 0.995,
		"MAX_TRACE_LENGTH": 512.0
	},
	uniforms: {
		"tDepth": { value: null },
		"tDiffuse": { value: null },
		"tNormal": { value: null },
		"samples": {value: 8},
		"size": { value: new Vector4( 512, 512, (1/512.0), (1/512.0) ) },
		"cameraNear": { value: 1 },
		"cameraFar": { value: 100 },
		"cameraProjectionMatrix": { value: new Matrix4() },
		"cameraInverseProjectionMatrix": { value: new Matrix4() },
		"intensity": { value: 0.1 },
		"distance": { value: 0.1 },
		"frameCount": { value: 0 },
	},
	vertexShader: [
	`
		varying vec2 vUv;

		void main() {
			vUv = uv;
			gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
		}

	`
	].join( "\n" ),
	fragmentShader: [
	`
		#include <common>

		varying vec2 vUv;

		uniform sampler2D tDiffuse;
		uniform sampler2D tDepth;

		#if NORMAL_TEXTURE == 1
		uniform sampler2D tNormal;
		#endif

		uniform float cameraNear;
		uniform float cameraFar;
		uniform mat4 cameraProjectionMatrix;
		uniform mat4 cameraInverseProjectionMatrix;

		uniform float intensity;	// Intenisty of the GTAO effect. (1 is physically correct)
		uniform float distance;		// distance in world space units to trace for occlusion 
		uniform uint frameCount;	// Number of frames rendered
		uniform vec4 size;			// Window w & h (xy) and 1 / window w & h (zw)

		// RGBA depth
		#include <packing>

		// Bit-wise AND not supported in GLES 3.0, but in this case:
		// x & 0x3 == x % 4 for uints
		float getSpatialDirection( const in uvec2 pos ) {
			float noise = 0.0625 *  float( ( ( ( ( pos.x + pos.y) % 4u ) << 2 ) + (pos.x % 4u ) ) ) ;
			return noise;
		}

		float getTemporalDirection( const uint frameCount ) {
			const float rotations[] = float[]( 0.16666667, 0.83333333, 0.5, 0.66666667, 0.33333333, 0.0 );
			return rotations[ frameCount % 6u ];
		}

		float getTemporalOffset( const uint frameCount ) {
			const float offsets[] = float[]( 0.0f, 0.5f, 0.25f, 0.75f );
			return offsets[ frameCount / 6u  % 4u];
		}

		vec3 fastSqrt( const in vec3 vec ) {
			//[Drobot2014a] Low Level Optimizations for GCN
			return intBitsToFloat( 0x1FBD1DF5 + ( floatBitsToInt( vec ) >> 1 ));
		}

		vec3 fastAcos( const in vec3 vec ) { 
			vec3 res = -0.156583 * abs( vec ) + PI_HALF; // Saves a divide present in the GTAO slides
			res *= fastSqrt( 1.0 - abs( vec ) );
			return vec3(
				vec.x >= 0.0 ? res.x : PI - res.x,
				vec.y >= 0.0 ? res.y : PI - res.y,
				vec.z >= 0.0 ? res.z : PI - res.z );
		}

		vec4 getAlbedo( const in vec2 screenPosition ) {
			return texture2D( tDiffuse, screenPosition );
		}

		// [ludobaka, bhouston]
		float getDepth( const in vec2 screenPosition ) {
			#if DEPTH_PACKING == 1
			return unpackRGBAToDepth( texture2D( tDepth, screenPosition ) );
			#else
			return texture2D( tDepth, screenPosition ).x;
			#endif
		}

		// [ludobaka, bhouston] Assume perspective camera.
		float getViewZ( const in float depth ) {
			return perspectiveDepthToViewZ( depth, cameraNear, cameraFar );
		}

		// [ludobaka, bhouston]
		vec3 getViewPosition( const in vec2 screenPosition, const in float depth, const in float viewZ ) {
			float clipW = cameraProjectionMatrix[2][3] * viewZ + cameraProjectionMatrix[3][3];
			vec4 clipPosition = vec4( ( vec3( screenPosition, depth ) - 0.5 ) * 2.0, 1.0 );
			clipPosition *= clipW; // unprojection.

			return ( cameraInverseProjectionMatrix * clipPosition ).xyz;
		}

		// [ludobaka, bhouston]
		vec3 getViewNormal( const in vec3 viewPosition, const in vec2 screenPosition ) {
			#if NORMAL_TEXTURE == 1
			vec3 texNormal = unpackRGBToNormal( texture2D( tNormal, screenPosition ).xyz );
			return texNormal;
			#else
			return normalize( cross( dFdx( viewPosition ), dFdy( viewPosition ) ) );
			#endif
		}

		#if STEP_PRECISION == 4
		const int SAMPLES = 16;
		#elif STEP_PRECISION == 3
		const int SAMPLES = 8;
		#elif STEP_PRECISION == 2
		const int SAMPLES = 4;
		#elif STEP_PRECISION == 1
		const int SAMPLES = 2;
		#else
		const int SAMPLES = 1;
		#endif

		// Move costly divides to compile time.
		const float ONE_DIV_SAMPLES = 1.0 / float( SAMPLES );

		float integrateSlice( const in vec3 pc, const in vec3 v, const in vec2 sliceDir, const in vec2 horizons ) {
			#if COSINE_WEIGHTING
			// Visibility of slice (cosine weighting)
			vec3 n = getViewNormal( pc, vUv );
			vec3 planeNormal = vec3( sliceDir.y, -sliceDir.x, 0.0 );	// Rotate slice direction by 90 degrees
			n = n - dot( planeNormal, n ) * planeNormal;
			float proj_n_length = length( n );
			n = normalize( n );
			
			// thetas.x = h1, thetas.y = h2, thetas.z = n
			vec3 thetas = fastAcos( vec3 ( horizons, dot ( v, n ) )); // Optimised to a single call instead of 3.

			// Clamp to hemisphere around normal.
			thetas.x = thetas.z + max( thetas.x - thetas.z, -PI_HALF );
			thetas.y = thetas.z + min( thetas.y - thetas.z, PI_HALF );

			thetas.x = 2.0 * thetas.x;
			thetas.y = 2.0 * thetas.y;

			vec2 n_trig = vec2( cos( thetas.z ), sin ( thetas.z ) ); // Save two trig functions.

			float vd = -cos( thetas.x - thetas.z ) + n_trig.x + thetas.x * n_trig.y;
			vd += -cos( thetas.y - thetas.z ) + n_trig.x + thetas.y * n_trig.y;
			vd = vd * proj_n_length;

			// The integral for cosine weighting on slide 61 is divided by pi instead of 2 * pi on slide 59.
			// i.e. (vd * 0.25 * 2) == (vd * 0.5)
			// It is unclear if this is correct, but it appears to me to more closely match the behaviour shown in
			// the slides. It also reduces the undesired effect of inaccurately occluded surfaces at grazing angles.
			vd = vd * 0.5;
			#else 
			// Visibility of slice (uniform weighting)
			vec3 thetas = fastAcos( vec3 ( horizons , 0.0 ) );
			float vd = 1.0 - cos( thetas.x ) + 1.0 - cos ( thetas.y );
			#endif

			return vd;
		}

		float calculateSliceVisibility( const in vec3 pc, const in float pixelDistance ) {
			vec3 v = normalize( -pc );

			uvec2 pixelCoords = uvec2( vUv * size.xy );

			float noise = getSpatialDirection( pixelCoords );
			float temporalDirection = getTemporalDirection( frameCount );
			float temporalOffsets = getTemporalOffset( frameCount );
			
			float slicePhi = noise * PI + ( ( temporalDirection + temporalOffsets ) * PI ); 
			vec2 sliceDir = vec2( cos( slicePhi ), sin ( slicePhi ) );

			vec2 hrz_max = vec2( 0.0 );	// Cosine of maximum horizon angle in s & t direction

			vec2 traceLine = sliceDir * ( min( ( distance / pixelDistance ), float( MAX_TRACE_LENGTH ) ) * size.z );

			// Here I could try clipping this traceLine to viewport bounds, but it's not that noticeable with 
			// GL_CLAMP_TO_EDGE on the textures, so I figured I'd save some instructions.

			vec2 step = traceLine * ONE_DIV_SAMPLES;
			vec4 steps = vec4( step, -step );
			vec4 sampleUV = vec4( vUv, vUv ); // Vectorise to save instructions.

			//Sample along slice pixels.
			for ( int i = 0; i < SAMPLES; i++ ) {
				sampleUV += steps;

				float sampleDepth = getDepth( sampleUV.xy );
				float sampleViewZ = getViewZ( sampleDepth );
				vec3 ps = getViewPosition( sampleUV.xy, sampleDepth, sampleViewZ );

				sampleDepth = getDepth( sampleUV.zw );
				sampleViewZ = getViewZ( sampleDepth );
				vec3 pt = getViewPosition( sampleUV.zw, sampleDepth, sampleViewZ );
				
				vec3 ds = ps - pc;
				float hrz_s_test = dot( ds, v ) / length(ds);
				hrz_max.s = max(hrz_max.s, hrz_s_test);

				vec3 dt = pt - pc;
				float hrz_t_test = dot( dt, v ) / length(dt);
				hrz_max.t = max(hrz_max.t, hrz_t_test);
			}

			return integrateSlice( pc, v, sliceDir, vec2( hrz_max.s, hrz_max.t ) );
		}

		// Calculate multiple bounces from approximate cubic polynomial correlation between single-bounce
		// and multi-bounce Monte Carlo algorithm. Include colour from multi-bounce (assume neighbouring
		// pixels are similar in albedo to current pixel's albedo).
		vec3 GTAOMultiBounce( const in float visibility, const in vec3 albedo) {
			vec3 a = 2.0404 * albedo - 0.3324;
			vec3 b = -4.7951 * albedo + 0.6417;
			vec3 c = 2.7552 * albedo + 0.6903;

			vec3 x = vec3( visibility );
			return max( x, ( ( x * a + b ) * x + c ) * x);
		}

		void main() {
			float depth = getDepth( vUv );
			float depthFade = smoothstep( BEGIN_DEPTH_FADE, END_DEPTH_FADE, depth );

			// Kill early if going to fade out anyway.
			if( depthFade >= 0.99 ) {
				discard;
			}

			float viewZ = getViewZ( depth );
			vec3 viewPosition = getViewPosition( vUv, depth, viewZ );

			// Make sure gtaoDistance is view-independent.
			// I would normally use dfdx to get pixel deltas, but I want to make sure depth and viewZ stay the same.
			vec3 offsetPos = getViewPosition( vUv + size.zw, depth, viewZ );
			float viewDelta = abs( offsetPos.x - viewPosition.x );

			float visibility = calculateSliceVisibility( viewPosition, viewDelta );

			#if MULTI_BOUNCE
			vec4 albedo = getAlbedo( vUv );
			vec3 gtao = GTAOMultiBounce(visibility, albedo.rgb);
			#else
			vec3 gtao = vec3(visibility);
			#endif

			gtao = mix( gtao, vec3(1.0), depthFade );

			gl_FragColor.xyz = mix(vec3(1.0),gtao,intensity);
		}
	`
	].join( "\n" )
};

export { GTAOShader };