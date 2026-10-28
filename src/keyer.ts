// Green / blue screen keyer on the GPU (WebGL), the same approach as WebMix Pro.
// Each keyed source owns one small GL canvas that the compositor draws from.

export interface Keyer {
  canvas: HTMLCanvasElement;
  run(src: HTMLVideoElement | HTMLImageElement, w: number, h: number, color: 'green' | 'blue', tolerance: number): boolean;
}

const VERT = 'attribute vec2 p;varying vec2 uv;void main(){uv=vec2((p.x+1.0)*0.5,(1.0-p.y)*0.5);gl_Position=vec4(p,0.0,1.0);}';
const FRAG = `precision mediump float;
uniform sampler2D tex;uniform float hard;uniform float soft;uniform float blue;varying vec2 uv;
void main(){
  vec4 c=texture2D(tex,uv);
  float k=mix(c.g,c.b,blue);
  float o=mix(max(c.r,c.b),max(c.r,c.g),blue);
  float d=k-o;
  float a=1.0;
  if(d>0.0){
    a=1.0-smoothstep(soft,hard,d);
    if(blue>0.5){c.b=o;}else{c.g=o;}
  }
  gl_FragColor=vec4(c.rgb*a,a);
}`;

export function createKeyer(): Keyer | null {
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl', { premultipliedAlpha: true, antialias: false });
  if (!gl) return null;
  const compile = (type: number, src: string) => {
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) ?? 'shader');
    return sh;
  };
  try {
    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
    gl.useProgram(prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const uHard = gl.getUniformLocation(prog, 'hard');
    const uSoft = gl.getUniformLocation(prog, 'soft');
    const uBlue = gl.getUniformLocation(prog, 'blue');
    return {
      canvas,
      run(src, w, h, color, tolerance) {
        if (canvas.width !== w || canvas.height !== h) {
          canvas.width = w;
          canvas.height = h;
          gl.viewport(0, 0, w, h);
        }
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
        gl.uniform1f(uHard, tolerance / 255);
        gl.uniform1f(uSoft, (tolerance * 0.5) / 255);
        gl.uniform1f(uBlue, color === 'blue' ? 1 : 0);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        return !gl.isContextLost();
      },
    };
  } catch {
    return null;
  }
}
