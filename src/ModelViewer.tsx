import { Component, lazy, Suspense, type ComponentProps, type ReactNode } from 'react';
const Viewer = lazy(() => import('./Viewer'));
class ViewerBoundary extends Component<{children:ReactNode;downloadUrl?:string},{failed:boolean}> {
  state={failed:false};
  static getDerivedStateFromError(){return {failed:true};}
  render(){return this.state.failed?<div className="viewer-shell"><div className="viewer-fallback" role="alert"><strong>三维查看器暂时无法加载</strong><p>其它功能仍可使用。连接恢复后可刷新页面，草稿会保留。</p><div className="viewer-fallback-actions"><button onClick={()=>window.location.reload()}>刷新页面</button>{this.props.downloadUrl?<a href={this.props.downloadUrl} download>下载模型</a>:null}</div></div></div>:this.props.children;}
}
export default function ModelViewer(props: ComponentProps<typeof Viewer>) {
  return <ViewerBoundary key={props.url} downloadUrl={props.downloadUrl}><Suspense fallback={<div className="viewer-shell" role="status">正在加载三维查看器…</div>}><Viewer {...props} /></Suspense></ViewerBoundary>;
}
