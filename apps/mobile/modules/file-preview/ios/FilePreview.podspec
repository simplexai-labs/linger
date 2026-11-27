Pod::Spec.new do |s|
  s.name           = 'FilePreview'
  s.version        = '1.0.0'
  s.summary        = 'Shows a local file in the system viewer.'
  s.author         = 'Linger'
  s.homepage       = 'https://heylinger.com'
  s.license        = 'UNLICENSED'
  s.platforms      = { :ios => '16.4' }
  s.source         = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '**/*.swift'
end
