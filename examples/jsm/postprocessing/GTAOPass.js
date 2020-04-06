/**
 * @author ludobaka / ludobaka.github.io
 * SAO implementation inspired from bhouston previous SAO work
 */

import {
	AddEquation,
	Color,
	CustomBlending,
	DepthTexture,
	DstAlphaFactor,
	DstColorFactor,
	LinearFilter,
	MeshDepthMaterial,
	MeshNormalMaterial,
	NearestFilter,
	NoBlending,
	RGBADepthPacking,
	RGBAFormat,
	Mesh,
	ShaderMaterial,
	UniformsUtils,
	UnsignedShortType,
	Vector2,
	WebGLRenderTarget,
	ZeroFactor
} from "../../../build/three.module.js";
import { Pass } from "../postprocessing/Pass.js";
import { GTAOShader } from "../shaders/GTAOShader.js";
import { DepthLimitedBlurShader } from "../shaders/DepthLimitedBlurShader.js";
import { BlurShaderUtils } from "../shaders/DepthLimitedBlurShader.js";
import { CopyShader } from "../shaders/CopyShader.js";
import { BlendShader } from "../shaders/BlendShader.js";
import { UnpackDepthRGBAShader } from "../shaders/UnpackDepthRGBAShader.js";

var GTAOPass = function ( scene, camera, depthTexture, useNormals, resolution ) {

	Pass.call( this );

	this.scene = scene;
	this.camera = camera;

	this.clear = true;
	this.needsSwap = false;

	this.supportsDepthTextureExtension = ( depthTexture !== undefined ) ? depthTexture : false;
	this.supportsNormalTexture = ( useNormals !== undefined ) ? useNormals : false;

	this.originalClearColor = new Color();
	this.oldClearColor = new Color();
	this.oldClearAlpha = 1;

	this.params = {
		output: 0,
		exposure: 1.5,
		gtaoIntensity: 1.0,
		gtaoDistance: 2.0,
		gtaoStepPrecision: 3,
		gtaoMultiBounce: true,
		gtaoHalfRes: false,
		gtaoCosineWeighting: true,
		gtaoSpatialDenoise: true,
		gtaoTemporalDenoise: true,
		gtaoBlurRadius: 4,
		gtaoBlurStdDev: 4,
		gtaoBlurDepthCutoff: 0.001,
		gtaoTemporalFrameWeighting: 0.5
	};

	this.resolution = ( resolution !== undefined ) ? new Vector2( resolution.x, resolution.y ) : new Vector2( 256, 256 );
	this.frameCount = 0;

	this.gtaoRenderTarget = new WebGLRenderTarget( this.resolution.x, this.resolution.y, {
		minFilter: LinearFilter,
		magFilter: LinearFilter,
		format: RGBAFormat
	} );
	this.blurIntermediateRenderTarget = this.gtaoRenderTarget.clone();
	this.gtaoAccumRenderTarget = this.gtaoRenderTarget.clone();

	this.beautyRenderTarget = this.gtaoRenderTarget.clone();
	this.albedoRenderTarget = this.gtaoRenderTarget.clone();

	this.normalRenderTarget = new WebGLRenderTarget( this.resolution.x, this.resolution.y, {
		minFilter: NearestFilter,
		magFilter: NearestFilter,
		format: RGBAFormat
	} );
	this.depthRenderTarget = this.normalRenderTarget.clone();

	if ( this.supportsDepthTextureExtension ) {

		var depthTexture = new DepthTexture();
		depthTexture.type = UnsignedShortType;
		depthTexture.minFilter = NearestFilter;
		depthTexture.maxFilter = NearestFilter;

		this.beautyRenderTarget.depthTexture = depthTexture;
		this.beautyRenderTarget.depthBuffer = true;
	}

	this.depthMaterial = new MeshDepthMaterial();
	this.depthMaterial.depthPacking = RGBADepthPacking;
	this.depthMaterial.blending = NoBlending;

	this.normalMaterial = new MeshNormalMaterial();
	this.normalMaterial.blending = NoBlending;

	if ( GTAOShader === undefined ) {
		console.error( 'THREE.GTAOPass relies on GTAOShader' );
	}

	this.gtaoMaterial = new ShaderMaterial( {
		defines: Object.assign( {}, GTAOShader.defines ),
		fragmentShader: GTAOShader.fragmentShader,
		vertexShader: GTAOShader.vertexShader,
		uniforms: UniformsUtils.clone( GTAOShader.uniforms )
	} );
	this.gtaoMaterial.extensions.derivatives = true;
	this.gtaoMaterial.defines[ 'DEPTH_PACKING' ] = this.supportsDepthTextureExtension ? 0 : 1;
	this.gtaoMaterial.defines[ 'NORMAL_TEXTURE' ] = this.supportsNormalTexture ? 1 : 0;
	this.gtaoMaterial.defines[ 'PERSPECTIVE_CAMERA' ] = this.camera.isPerspectiveCamera ? 1 : 0;
	this.gtaoMaterial.uniforms[ 'tDiffuse' ].value = this.albedoRenderTarget.texture;
	this.gtaoMaterial.uniforms[ 'tDepth' ].value = ( this.supportsDepthTextureExtension ) ? depthTexture : this.depthRenderTarget.texture;
	this.gtaoMaterial.uniforms[ 'tNormal' ].value = this.normalRenderTarget.texture;
	this.gtaoMaterial.uniforms[ 'size' ].value.set( this.resolution.x, this.resolution.y );
	this.gtaoMaterial.uniforms[ 'cameraInverseProjectionMatrix' ].value.getInverse( this.camera.projectionMatrix );
	this.gtaoMaterial.uniforms[ 'cameraProjectionMatrix' ].value = this.camera.projectionMatrix;
	this.gtaoMaterial.blending = NoBlending;

	if ( DepthLimitedBlurShader === undefined ) {

		console.error( 'THREE.GTAOPass relies on DepthLimitedBlurShader' );

	}

	this.vBlurMaterial = new ShaderMaterial( {
		uniforms: UniformsUtils.clone( DepthLimitedBlurShader.uniforms ),
		defines: Object.assign( {}, DepthLimitedBlurShader.defines ),
		vertexShader: DepthLimitedBlurShader.vertexShader,
		fragmentShader: DepthLimitedBlurShader.fragmentShader
	} );
	this.vBlurMaterial.defines[ 'DEPTH_PACKING' ] = this.supportsDepthTextureExtension ? 0 : 1;
	this.vBlurMaterial.defines[ 'PERSPECTIVE_CAMERA' ] = this.camera.isPerspectiveCamera ? 1 : 0;
	this.vBlurMaterial.uniforms[ 'tDiffuse' ].value = this.gtaoRenderTarget.texture;
	this.vBlurMaterial.uniforms[ 'tDepth' ].value = ( this.supportsDepthTextureExtension ) ? depthTexture : this.depthRenderTarget.texture;
	this.vBlurMaterial.uniforms[ 'size' ].value.set( this.resolution.x, this.resolution.y );
	this.vBlurMaterial.blending = NoBlending;

	this.hBlurMaterial = new ShaderMaterial( {
		uniforms: UniformsUtils.clone( DepthLimitedBlurShader.uniforms ),
		defines: Object.assign( {}, DepthLimitedBlurShader.defines ),
		vertexShader: DepthLimitedBlurShader.vertexShader,
		fragmentShader: DepthLimitedBlurShader.fragmentShader
	} );
	this.hBlurMaterial.defines[ 'DEPTH_PACKING' ] = this.supportsDepthTextureExtension ? 0 : 1;
	this.hBlurMaterial.defines[ 'PERSPECTIVE_CAMERA' ] = this.camera.isPerspectiveCamera ? 1 : 0;
	this.hBlurMaterial.uniforms[ 'tDiffuse' ].value = this.blurIntermediateRenderTarget.texture;
	this.hBlurMaterial.uniforms[ 'tDepth' ].value = ( this.supportsDepthTextureExtension ) ? depthTexture : this.depthRenderTarget.texture;
	this.hBlurMaterial.uniforms[ 'size' ].value.set( this.resolution.x, this.resolution.y );
	this.hBlurMaterial.blending = NoBlending;

	if ( CopyShader === undefined ) {

		console.error( 'THREE.GTAOPass relies on CopyShader' );

	}

	this.temporalDenoiserMaterial = new ShaderMaterial( {
		uniforms: UniformsUtils.clone( BlendShader.uniforms ),
		vertexShader: BlendShader.vertexShader,
		fragmentShader: BlendShader.fragmentShader
	} );
	this.temporalDenoiserMaterial.transparent = true;
	this.temporalDenoiserMaterial.depthTest = false;
	this.temporalDenoiserMaterial.depthWrite = false;
	this.temporalDenoiserMaterial.blending = CustomBlending;
	this.temporalDenoiserMaterial.blendSrc = DstColorFactor;
	this.temporalDenoiserMaterial.blendDst = ZeroFactor;
	this.temporalDenoiserMaterial.blendEquation = AddEquation;
	this.temporalDenoiserMaterial.blendSrcAlpha = DstAlphaFactor;
	this.temporalDenoiserMaterial.blendDstAlpha = ZeroFactor;
	this.temporalDenoiserMaterial.blendEquationAlpha = AddEquation;

	this.materialCopy = new ShaderMaterial( {
		uniforms: UniformsUtils.clone( CopyShader.uniforms ),
		vertexShader: CopyShader.vertexShader,
		fragmentShader: CopyShader.fragmentShader,
		blending: NoBlending
	} );
	this.materialCopy.transparent = true;
	this.materialCopy.depthTest = false;
	this.materialCopy.depthWrite = false;
	this.materialCopy.blending = CustomBlending;
	this.materialCopy.blendSrc = DstColorFactor;
	this.materialCopy.blendDst = ZeroFactor;
	this.materialCopy.blendEquation = AddEquation;
	this.materialCopy.blendSrcAlpha = DstAlphaFactor;
	this.materialCopy.blendDstAlpha = ZeroFactor;
	this.materialCopy.blendEquationAlpha = AddEquation;

	this.gammaCorrectMaterial = new ShaderMaterial( {
		defines: Object.assign( {}, GTAOShader.defines ),
		fragmentShader: GTAOShader.fragmentShader,
		vertexShader: GTAOShader.vertexShader,
		uniforms: UniformsUtils.clone( GTAOShader.uniforms )
	} );

	if ( UnpackDepthRGBAShader === undefined ) {

		console.error( 'THREE.GTAOPass relies on UnpackDepthRGBAShader' );

	}

	this.depthCopy = new ShaderMaterial( {
		uniforms: UniformsUtils.clone( UnpackDepthRGBAShader.uniforms ),
		vertexShader: UnpackDepthRGBAShader.vertexShader,
		fragmentShader: UnpackDepthRGBAShader.fragmentShader,
		blending: NoBlending
	} );

	this.fsQuad = new Pass.FullScreenQuad( null );

};

GTAOPass.OUTPUT = {
	'Beauty': 1,
	'Default': 0,
	'GTAO': 2,
	'Depth': 3,
	'Normal': 4,
	'Albedo': 5
};

GTAOPass.prototype = Object.assign( Object.create( Pass.prototype ), {
	constructor: GTAOPass,

	render: function ( renderer, writeBuffer, readBuffer/*, deltaTime, maskActive*/ ) {

		// Rendering readBuffer first when rendering to screen
		if ( this.renderToScreen ) {

			this.materialCopy.blending = NoBlending;
			this.materialCopy.uniforms[ 'tDiffuse' ].value = readBuffer.texture;
			this.materialCopy.needsUpdate = true;
			this.renderPass( renderer, this.materialCopy, null );
		}

		if ( this.params.output === 1 ) {
			return;
		}

		this.oldClearColor.copy( renderer.getClearColor() );
		this.oldClearAlpha = renderer.getClearAlpha();
		var oldAutoClear = renderer.autoClear;
		renderer.autoClear = false;

		renderer.setRenderTarget( this.depthRenderTarget );
		renderer.clear();

		this.frameCount += 1;	// Increment Frame Count

		if ( this.gtaoMaterial.defines[ 'STEP_PRECISION' ] != this.params.gtaoStepPrecision ) {
			this.gtaoMaterial.defines[ 'STEP_PRECISION' ] = this.params.gtaoStepPrecision;
			this.gtaoMaterial.needsUpdate = true;
		}

		if ( this.gtaoMaterial.defines[ 'MULTI_BOUNCE' ] != this.params.gtaoMultiBounce ? 1 : 0 ) {
			this.gtaoMaterial.defines[ 'MULTI_BOUNCE' ] = this.params.gtaoMultiBounce ? 1 : 0;
			this.gtaoMaterial.needsUpdate = true;
		}

		if ( this.gtaoMaterial.defines[ 'COSINE_WEIGHTING' ] != this.params.gtaoCosineWeighting ? 1 : 0 ) {
			this.gtaoMaterial.defines[ 'COSINE_WEIGHTING' ] = this.params.gtaoCosineWeighting ? 1 : 0;
			this.gtaoMaterial.needsUpdate = true;
		}

		this.gtaoMaterial.uniforms[ 'frameCount' ].value = this.frameCount;
		this.gtaoMaterial.uniforms[ 'intensity' ].value = this.params.gtaoIntensity;
		this.gtaoMaterial.uniforms[ 'distance' ].value = this.params.gtaoDistance;
		this.gtaoMaterial.uniforms[ 'cameraNear' ].value = this.camera.near;
		this.gtaoMaterial.uniforms[ 'cameraFar' ].value = this.camera.far;

		var depthCutoff = this.params.gtaoBlurDepthCutoff * ( this.camera.far - this.camera.near );
		this.vBlurMaterial.uniforms[ 'depthCutoff' ].value = depthCutoff;
		this.hBlurMaterial.uniforms[ 'depthCutoff' ].value = depthCutoff;

		this.vBlurMaterial.uniforms[ 'cameraNear' ].value = this.camera.near;
		this.vBlurMaterial.uniforms[ 'cameraFar' ].value = this.camera.far;
		this.hBlurMaterial.uniforms[ 'cameraNear' ].value = this.camera.near;
		this.hBlurMaterial.uniforms[ 'cameraFar' ].value = this.camera.far;

		this.temporalDenoiserMaterial.uniforms[ 'mixRatio' ].value = this.params.gtaoTemporalFrameWeighting;

		this.params.gtaoBlurRadius = Math.floor( this.params.gtaoBlurRadius );
		if ( ( this.prevStdDev !== this.params.gtaoBlurStdDev ) || ( this.prevNumSamples !== this.params.gtaoBlurRadius ) ) {

			BlurShaderUtils.configure( this.vBlurMaterial, this.params.gtaoBlurRadius, this.params.gtaoBlurStdDev, new Vector2( 0, 1 ) );
			BlurShaderUtils.configure( this.hBlurMaterial, this.params.gtaoBlurRadius, this.params.gtaoBlurStdDev, new Vector2( 1, 0 ) );
			this.prevStdDev = this.params.gtaoBlurStdDev;
			this.prevNumSamples = this.params.gtaoBlurRadius;

		}

		this.setMaterialsFromUserData(this.scene,'albedoMat');

		renderer.setClearColor( 0x000000 );
		renderer.setRenderTarget( this.albedoRenderTarget );
		renderer.clear();
		renderer.render( this.scene, this.camera );

		this.setMaterialsFromUserData(this.scene,'beautyMat');

		// Rendering scene to depth texture
		renderer.setClearColor( 0x000000 );
		renderer.setRenderTarget( this.beautyRenderTarget );
		renderer.clear();	// No need to clear, we have an HDRI background.
		renderer.render( this.scene, this.camera );

		// Re-render scene if depth texture extension is not supported
		if ( ! this.supportsDepthTextureExtension ) {

			// Clear rule : far clipping plane in both RGBA and Basic encoding
			this.renderOverride( renderer, this.depthMaterial, this.depthRenderTarget, 0x000000, 1.0 );
		}

		if ( this.supportsNormalTexture ) {

			// Clear rule : default normal is facing the camera
			this.renderOverride( renderer, this.normalMaterial, this.normalRenderTarget, 0x7777ff, 1.0 );
		}


		// Rendering GTAO texture
		this.renderPass( renderer, this.gtaoMaterial, this.gtaoRenderTarget, 0xffffff, 1.0 );

		// Blurring GTAO texture
		if ( this.params.gtaoSpatialDenoise ) {

			this.renderPass( renderer, this.vBlurMaterial, this.blurIntermediateRenderTarget, 0xffffff, 1.0 );
			this.renderPass( renderer, this.hBlurMaterial, this.gtaoRenderTarget, 0xffffff, 1.0 );
		}

		// Rudimentary Temporal Denoiser, reusing blurIntermediateRenderTarget as a temporary buffer.
		if ( this.params.gtaoTemporalDenoise ) {
			this.temporalDenoiserMaterial.uniforms[ 'tDiffuse1' ].value = this.gtaoAccumRenderTarget.texture;
			this.temporalDenoiserMaterial.uniforms[ 'tDiffuse2' ].value = this.gtaoRenderTarget.texture;
			this.renderPass( renderer, this.temporalDenoiserMaterial, this.blurIntermediateRenderTarget, 0xffffff, 1.0);

			this.materialCopy.uniforms[ 'tDiffuse' ].value = this.blurIntermediateRenderTarget.texture;
			this.renderPass( renderer, this.materialCopy, this.gtaoRenderTarget, 0xffffff, 1.0);

			this.materialCopy.uniforms[ 'tDiffuse' ].value = this.blurIntermediateRenderTarget.texture;
			this.renderPass( renderer, this.materialCopy, this.gtaoAccumRenderTarget, 0xffffff, 1.0);
		}

		var outputMaterial = this.materialCopy;
		// Setting up GTAO rendering
		if ( this.params.output === 3 ) {

			if ( this.supportsDepthTextureExtension ) {

				this.materialCopy.uniforms[ 'tDiffuse' ].value = this.beautyRenderTarget.depthTexture;
				this.materialCopy.needsUpdate = true;

			} else {

				this.depthCopy.uniforms[ 'tDiffuse' ].value = this.depthRenderTarget.texture;
				this.depthCopy.needsUpdate = true;
				outputMaterial = this.depthCopy;

			}

		} else if ( this.params.output === 4 ) {

			this.materialCopy.uniforms[ 'tDiffuse' ].value = this.normalRenderTarget.texture;
			this.materialCopy.needsUpdate = true;

		} else if ( this.params.output === 5 ) {

			this.materialCopy.uniforms[ 'tDiffuse' ].value = this.albedoRenderTarget.texture;
			this.materialCopy.needsUpdate = true;

		} else {

			this.materialCopy.uniforms[ 'tDiffuse' ].value = this.gtaoRenderTarget.texture;
			this.materialCopy.needsUpdate = true;
		}

		// Blending depends on output, only want a CustomBlending when showing GTAO
		if ( this.params.output === 0 ) {
			outputMaterial.blending = CustomBlending;

		} else {
			outputMaterial.blending = NoBlending;
		}

		// Rendering GTAOPass result on top of previous pass
		this.renderPass( renderer, outputMaterial, this.renderToScreen ? null : readBuffer );

		this.renderPass( renderer, outputMaterial, this.renderToScreen ? null : readBuffer );

		renderer.setClearColor( this.oldClearColor, this.oldClearAlpha );
		renderer.autoClear = oldAutoClear;

	},

	setMaterialsFromUserData: function ( scene, material ) {
		// https://stackoverflow.com/questions/16673937/three-js-how-to-access-items-inside-scene-should-i-use-document-getelementbyid
		scene.traverse ( function (object) {
			if (object instanceof Mesh) {
				if (object.userData[material] !== undefined) {
					object.material = object.userData[material];
				}
			}
		});
	},

	renderPass: function ( renderer, passMaterial, renderTarget, clearColor, clearAlpha ) {

		// save original state
		this.originalClearColor.copy( renderer.getClearColor() );
		var originalClearAlpha = renderer.getClearAlpha();
		var originalAutoClear = renderer.autoClear;

		renderer.setRenderTarget( renderTarget );

		// setup pass state
		renderer.autoClear = false;
		if ( ( clearColor !== undefined ) && ( clearColor !== null ) ) {

			renderer.setClearColor( clearColor );
			renderer.setClearAlpha( clearAlpha || 0.0 );
			renderer.clear();

		}

		this.fsQuad.material = passMaterial;
		this.fsQuad.render( renderer );

		// restore original state
		renderer.autoClear = originalAutoClear;
		renderer.setClearColor( this.originalClearColor );
		renderer.setClearAlpha( originalClearAlpha );

	},

	renderOverride: function ( renderer, overrideMaterial, renderTarget, clearColor, clearAlpha ) {

		this.originalClearColor.copy( renderer.getClearColor() );
		var originalClearAlpha = renderer.getClearAlpha();
		var originalAutoClear = renderer.autoClear;

		renderer.setRenderTarget( renderTarget );
		renderer.autoClear = false;

		clearColor = overrideMaterial.clearColor || clearColor;
		clearAlpha = overrideMaterial.clearAlpha || clearAlpha;
		if ( ( clearColor !== undefined ) && ( clearColor !== null ) ) {

			renderer.setClearColor( clearColor );
			renderer.setClearAlpha( clearAlpha || 0.0 );
			renderer.clear();

		}

		this.scene.overrideMaterial = overrideMaterial;
		renderer.render( this.scene, this.camera );
		this.scene.overrideMaterial = null;

		// restore original state
		renderer.autoClear = originalAutoClear;
		renderer.setClearColor( this.originalClearColor );
		renderer.setClearAlpha( originalClearAlpha );

	},

	setSize: function ( width, height ) {

		var gtaoWidth = width;
		var gtaoHeight = height;

		if ( this.params.gtaoHalfRes ) {
			gtaoWidth /= 2.0;
			gtaoHeight /= 2.0;
		}

		this.beautyRenderTarget.setSize( width, height );
		this.gtaoRenderTarget.setSize( gtaoWidth, gtaoHeight );
		this.blurIntermediateRenderTarget.setSize( width, height );
		this.gtaoAccumRenderTarget.setSize( width, height );
		this.normalRenderTarget.setSize( width, height );
		this.albedoRenderTarget.setSize( width, height );
		this.depthRenderTarget.setSize( width, height );

		this.gtaoMaterial.uniforms[ 'size' ].value.set( gtaoWidth, gtaoHeight, 1.0/gtaoWidth, 1.0/gtaoHeight );
		this.gtaoMaterial.uniforms[ 'cameraInverseProjectionMatrix' ].value.getInverse( this.camera.projectionMatrix );
		this.gtaoMaterial.uniforms[ 'cameraProjectionMatrix' ].value = this.camera.projectionMatrix;
		this.gtaoMaterial.needsUpdate = true;

		this.vBlurMaterial.uniforms[ 'size' ].value.set( width, height );
		this.vBlurMaterial.needsUpdate = true;

		this.hBlurMaterial.uniforms[ 'size' ].value.set( width, height );
		this.hBlurMaterial.needsUpdate = true;

	}

} );

export { GTAOPass };
