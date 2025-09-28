(function(){window.ScannerParts=window.ScannerParts||{};const ctx2d=(c,will=false)=>c.getContext('2d',will?{willReadFrequently:true}:undefined);
function upscaleSharpenAndBinarize(src,scale=2,thr=180,inv=false){
    const up=document.createElement('canvas');
    up.width=Math.max(1,Math.floor(src.width*scale));
    up.height=Math.max(1,Math.floor(src.height*scale));
    const ux=ctx2d(up,true);
    ux.imageSmoothingEnabled=true; ux.drawImage(src,0,0,up.width,up.height);

    const img=ux.getImageData(0,0,up.width,up.height), d=img.data, blur=new Uint8ClampedArray(d.length);
    for(let y=1;y<up.height-1;y++){
      for(let x=1;x<up.width-1;x++){
        const idx=(y*up.width+x)*4; let r=0,g=0,b=0;
        for(let yy=-1;yy<=1;yy++) for(let xx=-1;xx<=1;xx++){
          const i2=((y+yy)*up.width+(x+xx))*4; r+=d[i2]; g+=d[i2+1]; b+=d[i2+2];
        }
        blur[idx]=r/9; blur[idx+1]=g/9; blur[idx+2]=b/9; blur[idx+3]=255;
      }
    }
    for(let i=0;i<d.length;i+=4){
      d[i]=Math.max(0,Math.min(255,d[i]+(d[i]-blur[i])*0.6));
      d[i+1]=Math.max(0,Math.min(255,d[i+1]+(d[i+1]-blur[i+1])*0.6));
      d[i+2]=Math.max(0,Math.min(255,d[i+2]+(d[i+2]-blur[i+2])*0.6));
    }
    for(let i=0;i<d.length;i+=4){
      const Y=d[i]*0.299+d[i+1]*0.587+d[i+2]*0.114;
      const v = inv ? (Y<thr?255:0) : (Y>thr?255:0);
      d[i]=d[i+1]=d[i+2]=v; d[i+3]=255;
    }
    ux.putImageData(img,0,0);
    return up;
  }
window.ScannerParts.preprocess={upscaleSharpenAndBinarize};})();
